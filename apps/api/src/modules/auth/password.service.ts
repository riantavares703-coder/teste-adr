import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { loadEnv } from '../../config/env.js';

/**
 * Hash de senha com Argon2id (docs/03 §4).
 *
 * Parâmetros calibrados para ~250 ms no hardware de produção. Um pepper
 * (HMAC-SHA256 com chave em KMS) é aplicado ANTES do Argon2: um vazamento
 * apenas do banco — o cenário mais comum — não permite ataque offline, porque
 * falta uma chave que nunca esteve no banco.
 */
const ARGON_OPTIONS = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

/** Hash descartável usado para equalizar o tempo quando o usuário não existe. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$Y2xhdWRlLWR1bW15LXNhbHQ$8sKQ0Zx0m5r0pQ0hZ0oR0tR0oN0kL0mP0qS0uV0wX0Y';

@Injectable()
export class PasswordService {
  constructor(private readonly env = loadEnv()) {}

  private pepper(password: string): string {
    const key = this.env.PASSWORD_PEPPER;
    if (!key) return password;
    return createHmac('sha256', key).update(password).digest('base64');
  }

  async hash(password: string): Promise<string> {
    return argonHash(this.pepper(password), ARGON_OPTIONS);
  }

  async verify(storedHash: string | null, password: string): Promise<boolean> {
    // Executa o verify MESMO quando o usuário não existe (hash dummy), para que
    // o tempo de resposta não revele a existência da conta — item 3 do catálogo
    // de ameaças (enumeração de usuários).
    if (!storedHash) {
      await argonVerify(DUMMY_HASH, this.pepper(password)).catch(() => false);
      return false;
    }
    try {
      return await argonVerify(storedHash, this.pepper(password));
    } catch {
      return false;
    }
  }

  /** Comparação em tempo constante para OTP e tokens de uso único. */
  static safeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Política NIST SP 800-63B: comprimento importa, composição não.
   * O bloqueio por lista de senhas vazadas (HIBP k-anonymity) entra na Fase 2 —
   * é ele que realmente detém credential stuffing.
   */
  static validatePolicy(password: string): { ok: true } | { ok: false; reason: string } {
    if (password.length < 12) {
      return { ok: false, reason: 'A senha deve ter ao menos 12 caracteres' };
    }
    if (password.length > 128) {
      return { ok: false, reason: 'A senha deve ter no máximo 128 caracteres' };
    }
    return { ok: true };
  }
}
