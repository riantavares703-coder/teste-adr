import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../../config/env.js';

/**
 * Entrega do código OTP.
 *
 * Em produção o canal é WhatsApp (preferencial) com SMS de fallback — ambos
 * exigem credencial configurada. Quando NENHUM provedor está configurado, esta
 * implementação NÃO finge que enviou: ela registra explicitamente que o envio
 * foi PULADO e guarda o código em memória apenas para desenvolvimento e testes.
 *
 * `getDevCode()` lança em produção — o código nunca é recuperável fora de dev.
 */
@Injectable()
export class OtpDeliveryService {
  private readonly logger = new Logger('OtpDelivery');
  private readonly devCodes = new Map<string, { code: string; at: number }>();
  private readonly env = loadEnv();

  async send(identifier: string, code: string): Promise<{ delivered: boolean; reason?: string }> {
    if (this.env.WHATSAPP_PROVIDER === 'LOGGING') {
      this.devCodes.set(identifier, { code, at: Date.now() });
      this.logger.warn(
        `[PROVEDOR NÃO CONFIGURADO] OTP para ${maskIdentifier(identifier)} NÃO foi enviado. ` +
          `Configure WHATSAPP_PROVIDER=META_CLOUD_API para envio real.`,
      );
      return { delivered: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }

    // Envio real acontece pelo NotificationService (template de autenticação).
    // Mantido aqui como ponto de extensão explícito.
    throw new Error('Envio de OTP pelo provedor real ainda não implementado (Fase 2)');
  }

  /** Somente desenvolvimento e testes. Lança em produção, por construção. */
  getDevCode(identifier: string): string | null {
    if (this.env.NODE_ENV === 'production') {
      throw new Error('getDevCode não está disponível em produção');
    }
    return this.devCodes.get(identifier)?.code ?? null;
  }
}

function maskIdentifier(value: string): string {
  return value.length <= 4 ? '****' : `${value.slice(0, 3)}***${value.slice(-2)}`;
}
