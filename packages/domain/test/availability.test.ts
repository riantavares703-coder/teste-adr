import { describe, expect, it } from 'vitest';
import {
  canFulfill,
  computeAvailable,
  isLowStock,
  resolveAvailability,
  type InventorySnapshot,
} from '../src/availability.js';
import {
  canTransitionPayment,
  initialPaymentStatus,
  isOnSiteMethod,
  PAYMENT_STATUS,
} from '../src/payment-status.js';
import { businessDateFor, formatOrderNumber } from '../src/order-number.js';

const limited = (onHand: number, reserved = 0, soldOut = false): InventorySnapshot => ({
  mode: 'LIMITED',
  onHandQty: onHand,
  reservedQty: reserved,
  isManuallySoldOut: soldOut,
});

describe('resolveAvailability', () => {
  it('exemplo do briefing: 20 unidades disponíveis', () => {
    const view = resolveAvailability(limited(20));
    expect(view.availableQuantity).toBe(20);
    expect(view.isPurchasable).toBe(true);
  });

  it('ao chegar a zero o produto fica INDISPONÍVEL automaticamente', () => {
    expect(resolveAvailability(limited(1)).isPurchasable).toBe(true);
    const zerado = resolveAvailability(limited(0));
    expect(zerado.isPurchasable).toBe(false);
    expect(zerado.status).toBe('SOLD_OUT');
    expect(zerado.availableQuantity).toBe(0);
  });

  it('reservas reduzem o disponível sem alterar o físico', () => {
    const view = resolveAvailability(limited(10, 3));
    expect(view.availableQuantity).toBe(7);
  });

  it('tudo reservado equivale a esgotado para novos pedidos', () => {
    expect(resolveAvailability(limited(5, 5)).isPurchasable).toBe(false);
  });

  it('modo INFINITE nunca esgota e não expõe quantidade', () => {
    const view = resolveAvailability({
      mode: 'INFINITE',
      onHandQty: 0,
      reservedQty: 0,
      isManuallySoldOut: false,
    });
    expect(view.isPurchasable).toBe(true);
    expect(view.availableQuantity).toBeNull();
  });

  it('esgotamento manual vence a quantidade (decisão humana primeiro)', () => {
    const view = resolveAvailability(limited(50, 0, true));
    expect(view.isPurchasable).toBe(false);
    expect(view.status).toBe('MANUALLY_SOLD_OUT');
    // A quantidade é preservada: reativar não exige reinventar o número.
    expect(view.availableQuantity).toBe(50);
  });

  it('esgotamento manual também vence o modo INFINITE', () => {
    expect(
      resolveAvailability({
        mode: 'INFINITE',
        onHandQty: 0,
        reservedQty: 0,
        isManuallySoldOut: true,
      }).isPurchasable,
    ).toBe(false);
  });

  it('nunca retorna disponível negativo', () => {
    expect(computeAvailable(limited(3, 10))).toBe(0);
  });
});

describe('canFulfill', () => {
  it('permite exatamente a quantidade disponível', () => {
    expect(canFulfill(limited(3), 3)).toBe(true);
    expect(canFulfill(limited(3), 4)).toBe(false);
  });

  it('INFINITE atende qualquer quantidade', () => {
    expect(
      canFulfill(
        { mode: 'INFINITE', onHandQty: 0, reservedQty: 0, isManuallySoldOut: false },
        999,
      ),
    ).toBe(true);
  });

  it('produto esgotado manualmente não atende nada', () => {
    expect(canFulfill(limited(100, 0, true), 1)).toBe(false);
  });
});

describe('isLowStock', () => {
  it('alerta quando o disponível atinge o limite configurado', () => {
    expect(isLowStock(limited(3), 3)).toBe(true);
    expect(isLowStock(limited(4), 3)).toBe(false);
  });

  it('não alerta em modo INFINITE nem sem limite configurado', () => {
    expect(isLowStock(limited(1), null)).toBe(false);
    expect(
      isLowStock({ mode: 'INFINITE', onHandQty: 0, reservedQty: 0, isManuallySoldOut: false }, 5),
    ).toBe(false);
  });
});

describe('máquina de pagamento (separada da de pedido)', () => {
  it('não contém nenhum estado operacional de pedido', () => {
    const orderish = PAYMENT_STATUS.filter((s) => /PREPAR|READY|DELIVER|PICKUP/i.test(s));
    expect(orderish).toEqual([]);
  });

  it('Pix: PENDING -> AWAITING_CONFIRMATION -> CONFIRMED', () => {
    expect(
      canTransitionPayment({
        from: 'PENDING',
        to: 'AWAITING_CONFIRMATION',
        actorType: 'SYSTEM',
      }).allowed,
    ).toBe(true);
    expect(
      canTransitionPayment({
        from: 'AWAITING_CONFIRMATION',
        to: 'CONFIRMED',
        actorType: 'STAFF',
      }).allowed,
    ).toBe(true);
  });

  it('cliente NÃO pode confirmar o próprio pagamento', () => {
    const result = canTransitionPayment({
      from: 'AWAITING_CONFIRMATION',
      to: 'CONFIRMED',
      actorType: 'CUSTOMER',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('ACTOR_NOT_ALLOWED');
  });

  it('pagamento confirmado não volta a pendente', () => {
    expect(
      canTransitionPayment({ from: 'CONFIRMED', to: 'PENDING', actorType: 'STAFF' }).allowed,
    ).toBe(false);
  });

  it('confirmado só pode ir para estornado', () => {
    expect(
      canTransitionPayment({ from: 'CONFIRMED', to: 'REFUNDED', actorType: 'STAFF' }).allowed,
    ).toBe(true);
  });

  it('todo método nasce PENDING', () => {
    expect(initialPaymentStatus('PIX')).toBe('PENDING');
    expect(initialPaymentStatus('CASH_ON_SITE')).toBe('PENDING');
  });

  it('classifica corretamente os métodos presenciais', () => {
    expect(isOnSiteMethod('PIX')).toBe(false);
    expect(isOnSiteMethod('CASH_ON_SITE')).toBe(true);
    expect(isOnSiteMethod('CREDIT_ON_SITE')).toBe(true);
    expect(isOnSiteMethod('DEBIT_ON_SITE')).toBe(true);
  });
});

describe('número amigável', () => {
  it('começa em 1001', () => {
    expect(formatOrderNumber(1)).toBe('1001');
    expect(formatOrderNumber(42)).toBe('1042');
  });

  it('usa o fuso da unidade para a data de operação', () => {
    // 2026-03-10T02:30:00Z ainda é dia 9 em São Paulo (UTC-3)
    const instant = new Date('2026-03-10T02:30:00Z');
    expect(businessDateFor(instant, 'America/Sao_Paulo')).toBe('2026-03-09');
    expect(businessDateFor(instant, 'UTC')).toBe('2026-03-10');
  });
});
