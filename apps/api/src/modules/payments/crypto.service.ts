import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { loadEnv } from '../../config/env.js';

/**
 * Cifragem de dados sensíveis em repouso (chave Pix, segredo TOTP).
 *
 * AES-256-GCM com IV aleatório por operação e tag de autenticação.
 * Em produção a chave mestra vem do KMS (envelope encryption); aqui ela vem de
 * DATA_ENCRYPTION_KEY. Em desenvolvimento, uma chave efêmera é derivada — e o
 * dado cifrado com ela não sobrevive a um restart, o que é o comportamento
 * correto: nunca há chave fixa embutida no código.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly hmacKey: Buffer;

  constructor(env = loadEnv()) {
    const material = env.DATA_ENCRYPTION_KEY ?? randomBytes(32).toString('hex');
    this.key = scryptSync(material, 'plataforma-data-key', 32);
    this.hmacKey = scryptSync(material, 'plataforma-hmac-key', 32);
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    // formato: iv(12) || tag(16) || ciphertext
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): string {
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** HMAC determinístico: permite detectar troca de chave sem decifrar. */
  fingerprint(value: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(value).digest();
  }
}
