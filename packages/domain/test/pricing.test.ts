import { describe, expect, it } from 'vitest';
import { formatBRL, priceLine, priceOrder, PricingError } from '../src/pricing.js';

describe('priceLine', () => {
  it('calcula linha simples', () => {
    const line = priceLine({ unitPriceCents: 2990, quantity: 2, options: [] });
    expect(line.lineTotalCents).toBe(5980);
    expect(line.optionsTotalCents).toBe(0);
  });

  it('soma adicionais antes de multiplicar pela quantidade', () => {
    // (29,90 + 3,00 + 2,00) x 2 = 69,80 — e não 29,90x2 + 5,00
    const line = priceLine({
      unitPriceCents: 2990,
      quantity: 2,
      options: [
        { priceDeltaCents: 300, quantity: 1 },
        { priceDeltaCents: 200, quantity: 1 },
      ],
    });
    expect(line.optionsTotalCents).toBe(500);
    expect(line.lineTotalCents).toBe(6980);
  });

  it('multiplica adicional pela própria quantidade', () => {
    const line = priceLine({
      unitPriceCents: 1000,
      quantity: 1,
      options: [{ priceDeltaCents: 250, quantity: 3 }],
    });
    expect(line.lineTotalCents).toBe(1750);
  });

  it('aceita adicional com valor negativo (remoção com desconto)', () => {
    const line = priceLine({
      unitPriceCents: 2990,
      quantity: 1,
      options: [{ priceDeltaCents: -200, quantity: 1 }],
    });
    expect(line.lineTotalCents).toBe(2790);
  });

  it('recusa quando adicionais negativos tornam a linha negativa', () => {
    expect(() =>
      priceLine({
        unitPriceCents: 100,
        quantity: 1,
        options: [{ priceDeltaCents: -500, quantity: 1 }],
      }),
    ).toThrow(PricingError);
  });

  it('recusa quantidade zero, negativa ou acima do limite', () => {
    for (const quantity of [0, -1, 1000]) {
      expect(() => priceLine({ unitPriceCents: 100, quantity, options: [] })).toThrow(
        /Quantidade deve estar entre/,
      );
    }
  });

  it('recusa valores não inteiros (dinheiro é sempre centavos)', () => {
    expect(() => priceLine({ unitPriceCents: 29.9, quantity: 1, options: [] })).toThrow(
      /inteiro em centavos/,
    );
  });
});

describe('priceOrder', () => {
  it('total = subtotal + taxa - desconto', () => {
    const result = priceOrder({
      items: [
        { unitPriceCents: 2990, quantity: 2, options: [] },
        { unitPriceCents: 800, quantity: 1, options: [] },
      ],
      deliveryFeeCents: 700,
      discountCents: 500,
    });
    expect(result.subtotalCents).toBe(6780);
    expect(result.totalCents).toBe(6780 + 700 - 500);
  });

  it('não acumula erro de ponto flutuante em muitos itens', () => {
    // 3 x R$ 0,10 somado 1000 vezes: em float daria 30.000000000000384
    const items = Array.from({ length: 1000 }, () => ({
      unitPriceCents: 10,
      quantity: 3,
      options: [],
    }));
    const result = priceOrder({ items, deliveryFeeCents: 0, discountCents: 0 });
    expect(result.subtotalCents).toBe(30_000);
    expect(Number.isInteger(result.subtotalCents)).toBe(true);
  });

  it('recusa carrinho vazio', () => {
    expect(() => priceOrder({ items: [], deliveryFeeCents: 0, discountCents: 0 })).toThrow(
      /Carrinho vazio/,
    );
  });

  it('recusa desconto maior que subtotal + taxa', () => {
    expect(() =>
      priceOrder({
        items: [{ unitPriceCents: 1000, quantity: 1, options: [] }],
        deliveryFeeCents: 0,
        discountCents: 1001,
      }),
    ).toThrow(/Desconto não pode exceder/);
  });

  it('recusa taxa e desconto negativos', () => {
    const items = [{ unitPriceCents: 1000, quantity: 1, options: [] }];
    expect(() => priceOrder({ items, deliveryFeeCents: -1, discountCents: 0 })).toThrow();
    expect(() => priceOrder({ items, deliveryFeeCents: 0, discountCents: -1 })).toThrow();
  });
});

describe('formatBRL', () => {
  it('formata centavos como moeda brasileira', () => {
    expect(formatBRL(2990)).toBe('R$ 29,90');
    expect(formatBRL(5890)).toBe('R$ 58,90');
    expect(formatBRL(100)).toBe('R$ 1,00');
    expect(formatBRL(5)).toBe('R$ 0,05');
    expect(formatBRL(0)).toBe('R$ 0,00');
  });

  it('formata milhar', () => {
    expect(formatBRL(123456)).toBe('R$ 1.234,56');
  });
});
