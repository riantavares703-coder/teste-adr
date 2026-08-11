import { describe, expect, it } from 'vitest';
import {
  ACTIVE_ORDER_STATUSES,
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  canTransition,
  isTerminalOrderStatus,
  nextStatuses,
} from '../src/order-status.js';

const base = {
  fulfillment: 'PICKUP' as const,
  actorType: 'STAFF' as const,
  paymentMethod: 'CASH_ON_SITE',
  paymentConfirmed: false,
};

describe('separação das máquinas de estado (item 7 do Prompt 02)', () => {
  it('order_status NÃO contém nenhum estado de pagamento', () => {
    // A arquitetura do Prompt 01 tinha AWAITING_PAYMENT aqui; o Prompt 02 exige
    // que as duas máquinas não se misturem. Este teste trava a decisão.
    const paymentish = ORDER_STATUS.filter((s) => /PAY|PAID|PAGAMENT/i.test(s));
    expect(paymentish).toEqual([]);
  });
});

describe('canTransition — fluxo de retirada', () => {
  it('PENDING -> CONFIRMED -> PREPARING -> READY -> AWAITING_PICKUP -> PICKED_UP', () => {
    const path: Array<[string, string]> = [
      ['PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'PREPARING'],
      ['PREPARING', 'READY'],
      ['READY', 'AWAITING_PICKUP'],
      ['AWAITING_PICKUP', 'PICKED_UP'],
    ];
    for (const [from, to] of path) {
      const result = canTransition({ ...base, from: from as never, to: to as never });
      expect(result.allowed, `${from} -> ${to}`).toBe(true);
    }
  });

  it('retirada não pode ir para EM ROTA', () => {
    const result = canTransition({ ...base, from: 'READY', to: 'OUT_FOR_DELIVERY' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('WRONG_FULFILLMENT');
  });
});

describe('canTransition — fluxo de entrega', () => {
  const delivery = { ...base, fulfillment: 'DELIVERY' as const };

  it('READY -> OUT_FOR_DELIVERY -> DELIVERED', () => {
    expect(canTransition({ ...delivery, from: 'READY', to: 'OUT_FOR_DELIVERY' }).allowed).toBe(true);
    expect(canTransition({ ...delivery, from: 'OUT_FOR_DELIVERY', to: 'DELIVERED' }).allowed).toBe(
      true,
    );
  });

  it('entrega não pode ir para AGUARDANDO RETIRADA', () => {
    const result = canTransition({ ...delivery, from: 'READY', to: 'AWAITING_PICKUP' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('WRONG_FULFILLMENT');
  });
});

describe('canTransition — regras estruturais', () => {
  it('recusa pulo de etapa', () => {
    const result = canTransition({ ...base, from: 'CONFIRMED', to: 'READY' });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('INVALID_TRANSITION');
  });

  it('estados terminais não têm saída', () => {
    for (const from of ['DELIVERED', 'PICKED_UP', 'CANCELLED', 'REJECTED', 'EXPIRED'] as const) {
      expect(isTerminalOrderStatus(from)).toBe(true);
      for (const to of ORDER_STATUS) {
        const result = canTransition({ ...base, from, to });
        expect(result.allowed, `${from} -> ${to} deveria ser negado`).toBe(false);
      }
    }
  });

  it('cliente não pode avançar o status do pedido', () => {
    const result = canTransition({
      ...base,
      from: 'CONFIRMED',
      to: 'PREPARING',
      actorType: 'CUSTOMER',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('ACTOR_NOT_ALLOWED');
  });

  it('cliente pode cancelar enquanto o pedido está PENDING', () => {
    expect(
      canTransition({ ...base, from: 'PENDING', to: 'CANCELLED', actorType: 'CUSTOMER' }).allowed,
    ).toBe(true);
  });

  it('cancelamento durante o preparo exige motivo', () => {
    const semMotivo = canTransition({ ...base, from: 'PREPARING', to: 'CANCELLED' });
    expect(semMotivo.allowed).toBe(false);
    if (!semMotivo.allowed) expect(semMotivo.code).toBe('REASON_REQUIRED');

    const comMotivo = canTransition({
      ...base,
      from: 'PREPARING',
      to: 'CANCELLED',
      reason: 'Faltou insumo',
    });
    expect(comMotivo.allowed).toBe(true);
  });

  it('espaço em branco não conta como motivo', () => {
    const result = canTransition({
      ...base,
      from: 'PREPARING',
      to: 'CANCELLED',
      reason: '   ',
    });
    expect(result.allowed).toBe(false);
  });
});

describe('acoplamento mínimo com pagamento', () => {
  it('pedido Pix não é confirmado antes do pagamento confirmado', () => {
    const result = canTransition({
      ...base,
      from: 'PENDING',
      to: 'CONFIRMED',
      paymentMethod: 'PIX',
      paymentConfirmed: false,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('PAYMENT_NOT_CONFIRMED');
  });

  it('pedido Pix é confirmado quando o pagamento foi confirmado', () => {
    expect(
      canTransition({
        ...base,
        from: 'PENDING',
        to: 'CONFIRMED',
        paymentMethod: 'PIX',
        paymentConfirmed: true,
      }).allowed,
    ).toBe(true);
  });

  it('pagamento presencial NÃO bloqueia a confirmação (cobra-se na entrega)', () => {
    for (const method of ['CASH_ON_SITE', 'CREDIT_ON_SITE', 'DEBIT_ON_SITE']) {
      expect(
        canTransition({
          ...base,
          from: 'PENDING',
          to: 'CONFIRMED',
          paymentMethod: method,
          paymentConfirmed: false,
        }).allowed,
        method,
      ).toBe(true);
    }
  });
});

describe('nextStatuses', () => {
  it('oferece ao operador apenas os botões válidos para retirada', () => {
    expect(nextStatuses('READY', 'PICKUP').sort()).toEqual(['AWAITING_PICKUP']);
  });

  it('oferece ao operador apenas os botões válidos para entrega', () => {
    expect(nextStatuses('READY', 'DELIVERY').sort()).toEqual(['OUT_FOR_DELIVERY']);
  });

  it('não oferece nada em estado terminal', () => {
    expect(nextStatuses('DELIVERED', 'DELIVERY')).toEqual([]);
  });
});

describe('integridade da tabela de transições', () => {
  it('nenhuma transição parte de estado terminal', () => {
    for (const rule of ORDER_TRANSITIONS) {
      expect(isTerminalOrderStatus(rule.from), `${rule.from} -> ${rule.to}`).toBe(false);
    }
  });

  it('todo estado ativo tem ao menos uma saída (não há beco sem saída)', () => {
    for (const status of ACTIVE_ORDER_STATUSES) {
      const outs = ORDER_TRANSITIONS.filter((r) => r.from === status);
      expect(outs.length, `${status} não tem saída`).toBeGreaterThan(0);
    }
  });

  it('toda transição de staff declara a permissão exigida', () => {
    for (const rule of ORDER_TRANSITIONS) {
      if (rule.actors.includes('STAFF')) {
        expect(rule.permission, `${rule.from} -> ${rule.to}`).toBeDefined();
      }
    }
  });
});
