/**
 * Máquina de estados do PAGAMENTO — independente da máquina do pedido.
 *
 * Item 7 do Prompt 02: "O pedido deverá possuir estado de pagamento separado
 * do estado do pedido. Não misturar essas duas máquinas de estado."
 *
 * Um pedido pode estar EM_PREPARAÇÃO com pagamento PENDENTE (presencial),
 * ou PENDING com pagamento AWAITING_CONFIRMATION (Pix aguardando a loja
 * confirmar o recebimento). As duas dimensões são ortogonais.
 */

export const PAYMENT_STATUS = [
  'PENDING',
  'AWAITING_CONFIRMATION',
  'CONFIRMED',
  'FAILED',
  'REFUNDED',
  'CANCELLED',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const PAYMENT_METHOD = ['PIX', 'CREDIT_ON_SITE', 'DEBIT_ON_SITE', 'CASH_ON_SITE'] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

export function isOnSiteMethod(method: PaymentMethod): boolean {
  return method !== 'PIX';
}

export interface PaymentTransitionRule {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
  readonly permission?: string;
  readonly actors: readonly ('STAFF' | 'SYSTEM' | 'WEBHOOK' | 'CUSTOMER')[];
}

export const PAYMENT_TRANSITIONS: readonly PaymentTransitionRule[] = [
  // Pix: a cobrança é emitida (BR Code entregue ao cliente).
  { from: 'PENDING', to: 'AWAITING_CONFIRMATION', actors: ['SYSTEM'] },

  // Confirmação: manual pelo operador hoje; por webhook do PSP na Fase 2.
  {
    from: 'AWAITING_CONFIRMATION',
    to: 'CONFIRMED',
    permission: 'payment:confirm',
    actors: ['STAFF', 'WEBHOOK'],
  },
  // Presencial: confirmado na entrega/retirada, sem passar por AWAITING.
  { from: 'PENDING', to: 'CONFIRMED', permission: 'payment:confirm', actors: ['STAFF'] },

  { from: 'PENDING', to: 'CANCELLED', actors: ['STAFF', 'SYSTEM', 'CUSTOMER'] },
  { from: 'AWAITING_CONFIRMATION', to: 'CANCELLED', actors: ['STAFF', 'SYSTEM', 'CUSTOMER'] },
  { from: 'AWAITING_CONFIRMATION', to: 'FAILED', actors: ['SYSTEM', 'WEBHOOK'] },
  { from: 'PENDING', to: 'FAILED', actors: ['SYSTEM', 'WEBHOOK'] },

  { from: 'CONFIRMED', to: 'REFUNDED', permission: 'order:refund', actors: ['STAFF'] },
];

export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'CONFIRMED',
  'FAILED',
  'REFUNDED',
  'CANCELLED',
];

export type PaymentTransitionCheck =
  | { allowed: true; rule: PaymentTransitionRule }
  | { allowed: false; code: 'INVALID_TRANSITION' | 'ACTOR_NOT_ALLOWED'; message: string };

export function canTransitionPayment(input: {
  from: PaymentStatus;
  to: PaymentStatus;
  actorType: 'STAFF' | 'SYSTEM' | 'WEBHOOK' | 'CUSTOMER';
}): PaymentTransitionCheck {
  const candidates = PAYMENT_TRANSITIONS.filter(
    (r) => r.from === input.from && r.to === input.to,
  );
  if (candidates.length === 0) {
    return {
      allowed: false,
      code: 'INVALID_TRANSITION',
      message: `Transição de pagamento ${input.from} -> ${input.to} não existe.`,
    };
  }
  const rule = candidates.find((r) => r.actors.includes(input.actorType));
  if (!rule) {
    return {
      allowed: false,
      code: 'ACTOR_NOT_ALLOWED',
      message: `${input.actorType} não pode executar ${input.from} -> ${input.to}.`,
    };
  }
  return { allowed: true, rule };
}

/**
 * Estado inicial do pagamento conforme o método escolhido.
 * Pix nasce PENDING e vira AWAITING_CONFIRMATION assim que o BR Code é emitido.
 * Presencial nasce PENDING e só é confirmado na entrega.
 */
export function initialPaymentStatus(_method: PaymentMethod): PaymentStatus {
  return 'PENDING';
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  PENDING: 'Pendente',
  AWAITING_CONFIRMATION: 'Aguardando confirmação',
  CONFIRMED: 'Confirmado',
  FAILED: 'Falhou',
  REFUNDED: 'Estornado',
  CANCELLED: 'Cancelado',
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  PIX: 'Pix',
  CREDIT_ON_SITE: 'Crédito na entrega/retirada',
  DEBIT_ON_SITE: 'Débito na entrega/retirada',
  CASH_ON_SITE: 'Dinheiro na entrega/retirada',
};
