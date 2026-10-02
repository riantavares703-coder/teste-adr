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
  /** Credencial do provedor (Mercado Pago), já decifrada. */
  readonly accessToken?: string;
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

// -----------------------------------------------------------------------------
// Mercado Pago — Pix dinâmico
// -----------------------------------------------------------------------------

const MP_BASE_URL = 'https://api.mercadopago.com';
const MP_TIMEOUT_MS = 8_000;

export class MercadoPagoError extends Error {
  constructor(
    readonly httpStatus: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'MercadoPagoError';
  }
}

export type MercadoPagoStatus =
  | 'pending'
  | 'approved'
  | 'authorized'
  | 'in_process'
  | 'in_mediation'
  | 'rejected'
  | 'cancelled'
  | 'refunded'
  | 'charged_back';

export interface MercadoPagoPayment {
  readonly id: string;
  readonly status: MercadoPagoStatus;
  readonly amountCents: number;
  readonly externalReference: string | null;
  readonly qrCode: string | null;
}

interface MpPaymentResponse {
  id?: number | string;
  status?: string;
  transaction_amount?: number;
  external_reference?: string | null;
  point_of_interaction?: { transaction_data?: { qr_code?: string } };
}

function toPayment(body: MpPaymentResponse): MercadoPagoPayment {
  if (body.id === undefined || typeof body.transaction_amount !== 'number') {
    throw new MercadoPagoError(null, 'Resposta do Mercado Pago em formato inesperado');
  }
  return {
    id: String(body.id),
    status: (body.status ?? 'pending') as MercadoPagoStatus,
    // O MP devolve reais em ponto flutuante; arredondar evita 29.9 * 100 = 2989.9999.
    amountCents: Math.round(body.transaction_amount * 100),
    externalReference: body.external_reference ?? null,
    qrCode: body.point_of_interaction?.transaction_data?.qr_code ?? null,
  };
}

async function mpRequest(
  path: string,
  accessToken: string,
  init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
): Promise<unknown> {
  // `fetch` lido a cada chamada: os testes o substituem por um servidor falso.
  let response: Response;
  try {
    response = await fetch(`${MP_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(MP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MercadoPagoError(null, `Mercado Pago indisponível: ${(err as Error).message}`);
  }
  if (!response.ok) {
    // O corpo de erro do MP não carrega a credencial; ainda assim, só o status vai adiante.
    throw new MercadoPagoError(response.status, `Mercado Pago respondeu ${response.status}`);
  }
  return response.json();
}

/** Confere a credencial antes de salvá-la — token errado vira erro na tela de configuração, não no 1º pedido. */
export async function verifyMercadoPagoToken(accessToken: string): Promise<void> {
  await mpRequest('/users/me', accessToken, { method: 'GET' });
}

export async function fetchMercadoPagoPayment(
  accessToken: string,
  paymentId: string,
): Promise<MercadoPagoPayment> {
  const body = (await mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, accessToken, {
    method: 'GET',
  })) as MpPaymentResponse;
  return toPayment(body);
}

/**
 * Cobrança Pix dinâmica: o Mercado Pago emite o QR Code / "copia e cola" com o
 * valor EXATO do pedido e passa a conhecer o pagamento — é isso que permite
 * confirmar sem ninguém olhar o app do banco (ver PaymentsService.reconcile).
 */
export class MercadoPagoPixProvider implements PaymentProvider {
  readonly code = 'MERCADO_PAGO';
  readonly supportsAutomaticConfirmation = true;

  async createCharge(input: ChargeInput): Promise<ChargeResult> {
    if (!input.accessToken) {
      throw new MercadoPagoError(null, 'Credencial do Mercado Pago não configurada');
    }
    const body = (await mpRequest('/v1/payments', input.accessToken, {
      method: 'POST',
      // Mesma chave => mesmo pagamento: um retry do pedido não cobra duas vezes.
      idempotencyKey: `pedido-${input.orderId}`,
      body: {
        transaction_amount: input.amountCents / 100,
        payment_method_id: 'pix',
        description: `Pedido ${input.orderNumber}`,
        external_reference: input.orderId,
        payer: { email: `cliente.${input.orderNumber}@pedido.com.br` },
      },
    })) as MpPaymentResponse;

    const payment = toPayment(body);
    if (!payment.qrCode) {
      throw new MercadoPagoError(null, 'Mercado Pago não devolveu o código Pix');
    }
    if (payment.amountCents !== input.amountCents) {
      throw new MercadoPagoError(null, 'Valor da cobrança diverge do total do pedido');
    }
    return {
      provider: this.code,
      providerPaymentId: payment.id,
      pixBrcode: payment.qrCode,
      pixTxid: input.orderNumber,
      status: 'AWAITING_CONFIRMATION',
    };
  }
}
