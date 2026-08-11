import { Logger } from '@nestjs/common';

/**
 * Porta do WhatsApp (ADR-0009).
 *
 * Vocabulário deliberadamente livre de termos da Meta (`phone_number_id`,
 * `wamid`): trocar de provedor é escrever um adapter, não reescrever o sistema.
 *
 * PROIBIDO por decisão de arquitetura: WhatsApp Web automatizado, Selenium,
 * scraping, Baileys, whatsapp-web.js. O número banido seria o do LOJISTA, e
 * não temos o direito de assumir esse risco em nome de terceiros.
 */
export interface WhatsAppSendInput {
  readonly toPhoneE164: string;
  readonly templateName: string;
  readonly languageCode: string;
  /** Variáveis posicionais do template aprovado. */
  readonly variables: readonly string[];
  readonly idempotencyKey: string;
}

export type WhatsAppSendResult =
  | { status: 'SENT'; providerMessageId: string }
  | { status: 'SKIPPED'; reason: string }
  | { status: 'FAILED'; reason: string; retryable: boolean };

export interface WhatsAppProvider {
  readonly code: string;
  readonly isConfigured: boolean;
  send(input: WhatsAppSendInput): Promise<WhatsAppSendResult>;
}

/**
 * Adapter usado quando NENHUMA credencial da Meta está configurada.
 *
 * Ele NÃO finge que enviou: devolve SKIPPED com motivo explícito, e a
 * notificação é persistida com status SKIPPED. Em nenhum ponto do sistema uma
 * mensagem não enviada aparece como entregue.
 */
export class LoggingWhatsAppProvider implements WhatsAppProvider {
  readonly code = 'LOGGING';
  readonly isConfigured = false;
  private readonly logger = new Logger('WhatsApp/Logging');
  readonly sent: WhatsAppSendInput[] = [];

  async send(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    this.sent.push(input);
    this.logger.warn(
      `[PROVEDOR NÃO CONFIGURADO] template="${input.templateName}" ` +
        `destino=${maskPhone(input.toPhoneE164)} vars=[${input.variables.join(', ')}] — NÃO ENVIADO`,
    );
    return { status: 'SKIPPED', reason: 'WHATSAPP_PROVIDER_NOT_CONFIGURED' };
  }
}

/**
 * Adapter real da WhatsApp Business Platform (Cloud API).
 *
 * Só é instanciado quando há credencial. Exige templates previamente aprovados
 * pela Meta: mensagens de status são iniciadas pelo negócio e, portanto,
 * precisam de template — texto livre só valeria dentro da janela de 24 h.
 */
export class MetaCloudApiWhatsAppProvider implements WhatsAppProvider {
  readonly code = 'META_CLOUD_API';
  readonly isConfigured = true;
  private readonly logger = new Logger('WhatsApp/Meta');

  constructor(
    private readonly config: {
      baseUrl: string;
      phoneNumberId: string;
      accessToken: string;
      timeoutMs?: number;
    },
  ) {}

  async send(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    const url = `${this.config.baseUrl}/${this.config.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: input.toPhoneE164.replace('+', ''),
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: input.variables.length
          ? [
              {
                type: 'body',
                parameters: input.variables.map((text) => ({ type: 'text', text })),
              },
            ]
          : [],
      },
    };

    // Timeout obrigatório: sem ele, um worker travado consome a fila inteira.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.ok) {
        const json = (await response.json()) as { messages?: Array<{ id: string }> };
        const id = json.messages?.[0]?.id;
        return id
          ? { status: 'SENT', providerMessageId: id }
          : { status: 'FAILED', reason: 'RESPOSTA_SEM_ID', retryable: true };
      }

      const text = await response.text().catch(() => '');
      // 4xx (exceto 429) é erro permanente: retentar não resolve.
      const retryable = response.status === 429 || response.status >= 500;
      this.logger.error(`Falha ${response.status}: ${text.slice(0, 300)}`);
      return { status: 'FAILED', reason: `HTTP_${response.status}`, retryable };
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

function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `${phone.slice(0, 4)}****${phone.slice(-2)}`;
}
