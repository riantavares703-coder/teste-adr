import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, importSPKI } from 'jose';
import type { KeyLike } from 'jose';
import { loadEnv } from '../../config/env.js';
import { unauthorized } from '../../common/errors.js';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  typ: 'STAFF' | 'CUSTOMER';
  org?: string;
  ver: number;
}

/**
 * Emissão e verificação de tokens (ADR-0005).
 *
 * - Access token: JWT EdDSA (Ed25519), 10 min, com claims MÍNIMAS.
 *   Permissões NÃO entram no token: são resolvidas por requisição.
 * - Refresh token: opaco, 256 bits, guardado apenas como SHA-256.
 *
 * O algoritmo é FIXADO no verificador (`algorithms: ['EdDSA']`), nunca lido do
 * cabeçalho do token — é o que anula `alg: none` e a troca RS256->HS256.
 */
@Injectable()
export class TokenService {
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;
  private ready: Promise<void>;

  constructor(private readonly env = loadEnv()) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    if (this.env.JWT_PRIVATE_KEY_PEM && this.env.JWT_PUBLIC_KEY_PEM) {
      this.privateKey = await importPKCS8(this.env.JWT_PRIVATE_KEY_PEM, 'EdDSA');
      this.publicKey = await importSPKI(this.env.JWT_PUBLIC_KEY_PEM, 'EdDSA');
      return;
    }
    if (this.env.NODE_ENV === 'production') {
      // Nunca gerar chave efêmera em produção: reiniciar invalidaria todas as
      // sessões e cada réplica assinaria com uma chave diferente.
      throw new Error('JWT_PRIVATE_KEY_PEM/JWT_PUBLIC_KEY_PEM são obrigatórias em produção');
    }
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  /** Chaves para inspeção em dev; em produção vêm do secret manager. */
  async exportKeys(): Promise<{ privatePem: string; publicPem: string }> {
    await this.ready;
    return {
      privatePem: await exportPKCS8(this.privateKey),
      publicPem: await exportSPKI(this.publicKey),
    };
  }

  async issueAccessToken(claims: AccessTokenClaims): Promise<string> {
    await this.ready;
    const jwt = new SignJWT({
      sid: claims.sid,
      typ: claims.typ,
      ver: claims.ver,
      ...(claims.org ? { org: claims.org } : {}),
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(this.env.JWT_AUDIENCE)
      .setSubject(claims.sub)
      .setJti(randomBytes(16).toString('hex'))
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SECONDS}s`);
    return jwt.sign(this.privateKey);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    await this.ready;
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        algorithms: ['EdDSA'], // fixado aqui, jamais lido do token
        clockTolerance: 60,
      });
      return {
        sub: payload.sub as string,
        sid: payload.sid as string,
        typ: payload.typ as 'STAFF' | 'CUSTOMER',
        org: payload.org as string | undefined,
        ver: payload.ver as number,
      };
    } catch {
      throw unauthorized('TOKEN_INVALIDO', 'Token inválido ou expirado');
    }
  }

  /** Refresh token: 256 bits de aleatoriedade criptográfica, opaco. */
  generateRefreshToken(): { token: string; hash: Buffer } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefreshToken(token) };
  }

  /**
   * SHA-256 e não Argon2: não é segredo de baixa entropia como senha.
   * 256 bits aleatórios não sofrem força bruta offline, e o hash rápido
   * mantém o custo da renovação baixo.
   */
  hashRefreshToken(token: string): Buffer {
    return createHash('sha256').update(token).digest();
  }
}
