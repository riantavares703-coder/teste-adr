/**
 * Máquina de estados do PEDIDO.
 *
 * IMPORTANTE — separação das duas máquinas de estado (item 7 do Prompt 02):
 * este enum descreve APENAS o ciclo operacional do pedido. Ele não contém
 * nenhum estado de pagamento. "Aguardando pagamento" é a combinação
 * `order.status = PENDING` + `payment.status = AWAITING_CONFIRMATION`,
 * derivada na apresentação — nunca armazenada aqui.
 *
 * Ver docs/ARQUITETURA-DELTA.md §1.
 */

export const ORDER_STATUS = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'READY',
  'AWAITING_PICKUP',
  'OUT_FOR_DELIVERY',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
] as const;

export type OrderStatus = (typeof ORDER_STATUS)[number];

export const FULFILLMENT_TYPE = ['PICKUP', 'DELIVERY'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPE)[number];

/** Quem pode disparar uma transição. */
export const ACTOR_TYPE = ['CUSTOMER', 'STAFF', 'SYSTEM', 'WEBHOOK'] as const;
export type ActorType = (typeof ACTOR_TYPE)[number];

export interface TransitionRule {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  /** Permissão RBAC exigida (undefined = não exige permissão de staff). */
  readonly permission?: string;
  readonly actors: readonly ActorType[];
  /** Restringe a transição a um tipo de recebimento. */
  readonly onlyFulfillment?: FulfillmentType;
  /** Exige motivo textual registrado no histórico. */
  readonly requiresReason?: boolean;
  /**
   * Exige que o pagamento já esteja CONFIRMED.
   * Só a transição PENDING -> CONFIRMED depende do pagamento, e mesmo assim
   * apenas quando o método é PIX (pagamento presencial é cobrado na entrega).
   */
  readonly requiresPaidWhenPix?: boolean;
}

/**
 * Tabela de transições. A máquina é DADO, não `if/else` espalhado:
 * qualquer transição fora desta tabela é rejeitada com 409.
 */
export const ORDER_TRANSITIONS: readonly TransitionRule[] = [
  // --- entrada no fluxo ---
  {
    from: 'PENDING',
    to: 'CONFIRMED',
    permission: 'order:transition',
    actors: ['STAFF', 'SYSTEM'],
    requiresPaidWhenPix: true,
  },
  {
    from: 'PENDING',
    to: 'REJECTED',
    permission: 'order:transition',
    actors: ['STAFF'],
    requiresReason: true,
  },
  { from: 'PENDING', to: 'CANCELLED', permission: 'order:cancel', actors: ['CUSTOMER', 'STAFF'] },
  // Expiração da reserva de estoque quando o Pix não é pago a tempo.
  { from: 'PENDING', to: 'EXPIRED', actors: ['SYSTEM'] },

  // --- produção ---
  { from: 'CONFIRMED', to: 'PREPARING', permission: 'order:transition', actors: ['STAFF'] },
  {
    from: 'CONFIRMED',
    to: 'CANCELLED',
    permission: 'order:cancel',
    actors: ['STAFF'],
    requiresReason: true,
  },
  { from: 'PREPARING', to: 'READY', permission: 'order:transition', actors: ['STAFF'] },
  {
    from: 'PREPARING',
    to: 'CANCELLED',
    permission: 'order:cancel',
    actors: ['STAFF'],
    requiresReason: true,
  },

  // --- entrega do pedido ao cliente ---
  {
    from: 'READY',
    to: 'AWAITING_PICKUP',
    permission: 'order:transition',
    actors: ['STAFF', 'SYSTEM'],
    onlyFulfillment: 'PICKUP',
  },
  {
    from: 'READY',
    to: 'OUT_FOR_DELIVERY',
    permission: 'order:transition',
    actors: ['STAFF'],
    onlyFulfillment: 'DELIVERY',
  },
  {
    from: 'AWAITING_PICKUP',
    to: 'PICKED_UP',
    permission: 'order:transition',
    actors: ['STAFF'],
    onlyFulfillment: 'PICKUP',
  },
  {
    from: 'AWAITING_PICKUP',
    to: 'CANCELLED',
    permission: 'order:cancel',
    actors: ['STAFF'],
    requiresReason: true,
  },
  {
    from: 'OUT_FOR_DELIVERY',
    to: 'DELIVERED',
    permission: 'order:transition',
    actors: ['STAFF'],
    onlyFulfillment: 'DELIVERY',
  },
  {
    from: 'OUT_FOR_DELIVERY',
    to: 'CANCELLED',
    permission: 'order:cancel',
    actors: ['STAFF'],
    requiresReason: true,
  },
];

/** Estados terminais: não têm saída. Um pedido entregue nunca volta atrás. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
];

/** Estados em que o pedido ainda ocupa a fila da unidade. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ORDER_STATUS.filter(
  (s) => !TERMINAL_ORDER_STATUSES.includes(s),
);

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export type TransitionDenialCode =
  | 'TERMINAL_STATE'
  | 'INVALID_TRANSITION'
  | 'WRONG_FULFILLMENT'
  | 'ACTOR_NOT_ALLOWED'
  | 'REASON_REQUIRED'
  | 'PAYMENT_NOT_CONFIRMED';

export type TransitionCheck =
  | { allowed: true; rule: TransitionRule }
  | { allowed: false; code: TransitionDenialCode; message: string };

export interface TransitionContext {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly fulfillment: FulfillmentType;
  readonly actorType: ActorType;
  readonly paymentMethod: string;
  readonly paymentConfirmed: boolean;
  readonly reason?: string | null;
}

/**
 * Única fonte de verdade sobre "esta transição pode acontecer?".
 * Não verifica RBAC nem escopo de tenant — isso é responsabilidade da camada
 * de autorização da API, que usa `rule.permission`.
 */
export function canTransition(ctx: TransitionContext): TransitionCheck {
  if (isTerminalOrderStatus(ctx.from)) {
    return {
      allowed: false,
      code: 'TERMINAL_STATE',
      message: `Pedido em estado terminal (${ctx.from}) não admite transição.`,
    };
  }

  const candidates = ORDER_TRANSITIONS.filter((r) => r.from === ctx.from && r.to === ctx.to);
  if (candidates.length === 0) {
    return {
      allowed: false,
      code: 'INVALID_TRANSITION',
      message: `Transição ${ctx.from} -> ${ctx.to} não existe.`,
    };
  }

  // Uma transição pode existir para o outro tipo de recebimento.
  const byFulfillment = candidates.filter(
    (r) => !r.onlyFulfillment || r.onlyFulfillment === ctx.fulfillment,
  );
  if (byFulfillment.length === 0) {
    return {
      allowed: false,
      code: 'WRONG_FULFILLMENT',
      message: `Transição ${ctx.from} -> ${ctx.to} não se aplica a ${ctx.fulfillment}.`,
    };
  }

  const rule = byFulfillment.find((r) => r.actors.includes(ctx.actorType));
  if (!rule) {
    return {
      allowed: false,
      code: 'ACTOR_NOT_ALLOWED',
      message: `${ctx.actorType} não pode executar ${ctx.from} -> ${ctx.to}.`,
    };
  }

  if (rule.requiresReason && !ctx.reason?.trim()) {
    return {
      allowed: false,
      code: 'REASON_REQUIRED',
      message: `A transição ${ctx.from} -> ${ctx.to} exige motivo.`,
    };
  }

  // Pedido Pix só é confirmado depois que o pagamento é confirmado.
  // Pagamento presencial é cobrado na entrega/retirada, então não bloqueia.
  if (rule.requiresPaidWhenPix && ctx.paymentMethod === 'PIX' && !ctx.paymentConfirmed) {
    return {
      allowed: false,
      code: 'PAYMENT_NOT_CONFIRMED',
      message: 'Pagamento via Pix ainda não confirmado.',
    };
  }

  return { allowed: true, rule };
}

/** Próximos estados possíveis — usado pelo app do operador para montar os botões. */
export function nextStatuses(
  from: OrderStatus,
  fulfillment: FulfillmentType,
  actorType: ActorType = 'STAFF',
): OrderStatus[] {
  if (isTerminalOrderStatus(from)) return [];
  return ORDER_TRANSITIONS.filter(
    (r) =>
      r.from === from &&
      r.actors.includes(actorType) &&
      (!r.onlyFulfillment || r.onlyFulfillment === fulfillment),
  ).map((r) => r.to);
}

/** Rótulos em português para apresentação nos apps. */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Pedido recebido',
  CONFIRMED: 'Confirmado',
  PREPARING: 'Em preparação',
  READY: 'Pronto',
  AWAITING_PICKUP: 'Aguardando retirada',
  OUT_FOR_DELIVERY: 'Em rota',
  PICKED_UP: 'Retirado',
  DELIVERED: 'Entregue',
  CANCELLED: 'Cancelado',
  REJECTED: 'Recusado',
  EXPIRED: 'Expirado',
};
