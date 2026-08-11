import { Logger } from '@nestjs/common';

/**
 * Porta de push (FCM/APNs via Expo).
 *
 * O push é apenas GATILHO, nunca portador do dado: ele diz "algo mudou no
 * pedido X" e o app busca o estado real por REST. Assim, push perdido, fora de
 * ordem ou duplicado não corrompe a tela.
 */
export interface PushSendInput {
  readonly tokens: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
}

export type PushSendResult =
  | { status: 'SENT'; accepted: number }
  | { status: 'SKIPPED'; reason: string }
  | { status: 'FAILED'; reason: string; retryable: boolean };

export interface PushProvider {
  readonly code: string;
  readonly isConfigured: boolean;
  send(input: PushSendInput): Promise<PushSendResult>;
}

/** Sem credencial configurada: registra e devolve SKIPPED. Não finge envio. */
export class LoggingPushProvider implements PushProvider {
  readonly code = 'LOGGING';
  readonly isConfigured = false;
  private readonly logger = new Logger('Push/Logging');
  readonly sent: PushSendInput[] = [];

  async send(input: PushSendInput): Promise<PushSendResult> {
    this.sent.push(input);
    this.logger.warn(
      `[PROVEDOR NÃO CONFIGURADO] push "${input.title}" para ${input.tokens.length} dispositivo(s) — NÃO ENVIADO`,
    );
    return { status: 'SKIPPED', reason: 'PUSH_PROVIDER_NOT_CONFIGURED' };
  }
}

export class ExpoPushProvider implements PushProvider {
  readonly code = 'EXPO';
  readonly isConfigured = true;

  constructor(private readonly config: { url: string; timeoutMs?: number }) {}

  async send(input: PushSendInput): Promise<PushSendResult> {
    if (input.tokens.length === 0) {
      return { status: 'SKIPPED', reason: 'SEM_DISPOSITIVOS_REGISTRADOS' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          input.tokens.map((to) => ({
            to,
            title: input.title,
            body: input.body,
            data: input.data,
            sound: 'default',
            priority: 'high',
          })),
        ),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          status: 'FAILED',
          reason: `HTTP_${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      return { status: 'SENT', accepted: input.tokens.length };
    } catch (error) {
      return {
        status: 'FAILED',
        reason: (error as Error).name === 'AbortError' ? 'TIMEOUT' : 'ERRO_DE_REDE',
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
