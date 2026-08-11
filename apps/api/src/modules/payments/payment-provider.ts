import { buildPixBrCode } from '@plataforma/domain';

/**
 * Porta de pagamento (ADR-0008).
 *
 * O módulo `ordering` conhece apenas esta interface. Trocar a confirmação
 * manual por um PSP com webhook é escrever um adapter — não alterar pedido,
 * estoque nem os aplicativos.
 */
export interface ChargeInput {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly amountCents: number;
  readonly pixKey?: string;
  readonly merchantName?: string;
  readonly merchantCity?: string;
}

export interface ChargeResult {
  readonly provider: string;
  readonly providerPaymentId: string | null;
  readonly pixBrcode: string | null;
  readonly pixTxid: string | null;
  /** Estado inicial do pagamento após emitir a cobrança. */
  readonly status: 'PENDING' | 'AWAITING_CONFIRMATION';
}

export interface PaymentProvider {
  readonly code: string;
  /**
   * `false` hoje: nenhum provedor configurado confirma sozinho.
   * O app do cliente usa este campo para dizer, sem ambiguidade, que copiar a
   * chave não confirma nada e que a loja precisa confirmar o recebimento.
   */
  readonly supportsAutomaticConfirmation: boolean;
  createCharge(input: ChargeInput): Promise<ChargeResult>;
}

/**
 * Pix sem integração bancária.
 *
 * Gera o BR Code EMV localmente — formatação padronizada da chave, nome, cidade
 * e valor que já temos. NÃO é integração: não há PSP, não há custo e,
 * principalmente, NÃO HÁ NOTIFICAÇÃO DE RECEBIMENTO. A confirmação continua
 * sendo um ato do operador com permissão `payment:confirm`.
 */
export class ManualPixProvider implements PaymentProvider {
  readonly code = 'MANUAL_PIX';
  readonly supportsAutomaticConfirmation = false;

  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    if (!input.pixKey) {
      throw new Error('Chave Pix não configurada para esta unidade');
    }
    const brcode = buildPixBrCode({
      key: input.pixKey,
      merchantName: input.merchantName ?? 'RECEBEDOR',
      merchantCity: input.merchantCity ?? 'BRASIL',
      amountCents: input.amountCents,
      txid: input.orderNumber,
    });
    return {
      provider: this.code,
      providerPaymentId: null,
      pixBrcode: brcode,
      pixTxid: input.orderNumber,
      status: 'AWAITING_CONFIRMATION',
    };
  }
}

/** Crédito, débito ou dinheiro na entrega/retirada. Nenhum dado de cartão trafega. */
export class OnSitePaymentProvider implements PaymentProvider {
  readonly code = 'ON_SITE';
  readonly supportsAutomaticConfirmation = false;

  async createCharge(): Promise<ChargeResult> {
    return {
      provider: this.code,
      providerPaymentId: null,
      pixBrcode: null,
      pixTxid: null,
      status: 'PENDING',
    };
  }
}
