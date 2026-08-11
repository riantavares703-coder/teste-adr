/**
 * Cálculo de valores do pedido.
 *
 * REGRA CENTRAL (item 5 do Prompt 02): nenhum valor monetário vem do cliente.
 * Todas as entradas desta função são lidas do banco pelo servidor. O app do
 * cliente pode calcular o mesmo para exibir um total otimista, mas o valor
 * cobrado é SEMPRE o que sai daqui, no servidor.
 *
 * Dinheiro em BIGINT de centavos (ADR-0010): `0.1 + 0.2 !== 0.3` em ponto
 * flutuante binário, e erro de arredondamento em dinheiro é defeito financeiro.
 */

export interface PricedOption {
  /** Preço do adicional lido do banco, nunca do cliente. */
  readonly priceDeltaCents: number;
  readonly quantity: number;
}

export interface PricedItem {
  /** Preço unitário do produto lido do banco, nunca do cliente. */
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly options: readonly PricedOption[];
}

export interface PricingInput {
  readonly items: readonly PricedItem[];
  readonly deliveryFeeCents: number;
  readonly discountCents: number;
}

export interface PricedLine {
  readonly unitPriceCents: number;
  readonly optionsTotalCents: number;
  readonly quantity: number;
  readonly lineTotalCents: number;
}

export interface PricingResult {
  readonly lines: readonly PricedLine[];
  readonly subtotalCents: number;
  readonly deliveryFeeCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
}

export class PricingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

export const MAX_ITEM_QUANTITY = 999;

function assertInteger(value: number, field: string): void {
  if (!Number.isInteger(value)) {
    throw new PricingError('NOT_AN_INTEGER', `${field} deve ser inteiro em centavos, recebido ${value}`);
  }
}

/**
 * Calcula uma linha do pedido.
 * lineTotal = (preçoUnitário + Σ adicionais) × quantidade
 */
export function priceLine(item: PricedItem): PricedLine {
  assertInteger(item.unitPriceCents, 'unitPriceCents');
  assertInteger(item.quantity, 'quantity');

  if (item.unitPriceCents < 0) {
    throw new PricingError('NEGATIVE_PRICE', 'Preço unitário não pode ser negativo');
  }
  if (item.quantity < 1 || item.quantity > MAX_ITEM_QUANTITY) {
    throw new PricingError(
      'INVALID_QUANTITY',
      `Quantidade deve estar entre 1 e ${MAX_ITEM_QUANTITY}, recebido ${item.quantity}`,
    );
  }

  let optionsTotalCents = 0;
  for (const option of item.options) {
    assertInteger(option.priceDeltaCents, 'priceDeltaCents');
    assertInteger(option.quantity, 'option.quantity');
    if (option.quantity < 1) {
      throw new PricingError('INVALID_QUANTITY', 'Quantidade de adicional deve ser >= 1');
    }
    // priceDeltaCents pode ser negativo (ex.: "sem queijo, -R$ 2,00").
    optionsTotalCents += option.priceDeltaCents * option.quantity;
  }

  const unitWithOptions = item.unitPriceCents + optionsTotalCents;
  if (unitWithOptions < 0) {
    throw new PricingError(
      'NEGATIVE_LINE',
      'Adicionais não podem tornar o valor da linha negativo',
    );
  }

  return {
    unitPriceCents: item.unitPriceCents,
    optionsTotalCents,
    quantity: item.quantity,
    lineTotalCents: unitWithOptions * item.quantity,
  };
}

/**
 * Calcula o pedido inteiro.
 * total = subtotal + taxaEntrega − desconto
 *
 * O mesmo invariante existe como CHECK no banco (orders_total_chk): se este
 * cálculo divergir, a transação é abortada em vez de cobrar errado.
 */
export function priceOrder(input: PricingInput): PricingResult {
  if (input.items.length === 0) {
    throw new PricingError('EMPTY_CART', 'Carrinho vazio');
  }

  assertInteger(input.deliveryFeeCents, 'deliveryFeeCents');
  assertInteger(input.discountCents, 'discountCents');

  if (input.deliveryFeeCents < 0) {
    throw new PricingError('NEGATIVE_FEE', 'Taxa de entrega não pode ser negativa');
  }
  if (input.discountCents < 0) {
    throw new PricingError('NEGATIVE_DISCOUNT', 'Desconto não pode ser negativo');
  }

  const lines = input.items.map(priceLine);
  const subtotalCents = lines.reduce((acc, l) => acc + l.lineTotalCents, 0);

  if (input.discountCents > subtotalCents + input.deliveryFeeCents) {
    throw new PricingError(
      'DISCOUNT_TOO_LARGE',
      'Desconto não pode exceder subtotal + taxa de entrega',
    );
  }

  const totalCents = subtotalCents + input.deliveryFeeCents - input.discountCents;

  return {
    lines,
    subtotalCents,
    deliveryFeeCents: input.deliveryFeeCents,
    discountCents: input.discountCents,
    totalCents,
  };
}

/** Formatação para apresentação. O cálculo nunca usa string. */
export function formatBRL(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const centavos = abs % 100;
  return `${sign}R$ ${reais.toLocaleString('pt-BR')},${String(centavos).padStart(2, '0')}`;
}
