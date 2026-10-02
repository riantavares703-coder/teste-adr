import { describe, expect, it } from 'vitest';
import { formatBRL, priceOrder } from '../src/pricing.js';
import {
  buildPixBrCode,
  centsToEmvAmount,
  normalizePixKey,
  parseEmv,
  validateBrCodeChecksum,
} from '../src/pix-brcode.js';

/** PRNG determinístico (mulberry32): falha reproduzível, sem depender de Math.random. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, min: number, max: number) => min + Math.floor(r() * (max - min + 1));

describe('dinheiro: propriedades do cálculo do pedido', () => {
  it('o total bate com uma conta independente em BigInt, para 3000 carrinhos aleatórios', () => {
    const r = rng(20261002);
    for (let n = 0; n < 3000; n++) {
      const items = Array.from({ length: int(r, 1, 12) }, () => {
        const options = Array.from({ length: int(r, 0, 4) }, () => ({
          priceDeltaCents: int(r, 0, 1500),
          quantity: 1,
        }));
        return { unitPriceCents: int(r, 1, 50_000), quantity: int(r, 1, 30), options };
      });
      const fee = int(r, 0, 2000);

      const result = priceOrder({ items: items as never, deliveryFeeCents: fee, discountCents: 0 });

      let expected = 0n;
      for (const it of items) {
        const extras = it.options.reduce((s, o) => s + o.priceDeltaCents * o.quantity, 0);
        expected += BigInt(it.unitPriceCents + extras) * BigInt(it.quantity);
      }
      expect(result.subtotalCents).toBe(Number(expected));
      expect(result.totalCents).toBe(Number(expected) + fee);
      expect(Number.isSafeInteger(result.totalCents)).toBe(true);
      expect(result.lines.reduce((s, l) => s + l.lineTotalCents, 0)).toBe(result.subtotalCents);
    }
  });

  it('o total nunca é negativo, mesmo com desconto máximo', () => {
    const r = rng(7);
    for (let n = 0; n < 500; n++) {
      const unit = int(r, 1, 10_000);
      const qty = int(r, 1, 10);
      const fee = int(r, 0, 800);
      const total = unit * qty + fee;
      const res = priceOrder({
        items: [{ unitPriceCents: unit, quantity: qty, options: [] }] as never,
        deliveryFeeCents: fee,
        discountCents: total,
      });
      expect(res.totalCents).toBe(0);
    }
  });

  it('dinheiro fracionário nunca entra: qualquer valor não inteiro é recusado', () => {
    for (const bad of [0.5, 29.9, 1e-9, NaN, Infinity]) {
      expect(() =>
        priceOrder({ items: [{ unitPriceCents: bad, quantity: 1, options: [] }] as never, deliveryFeeCents: 0, discountCents: 0 }),
      ).toThrow();
    }
  });
});

describe('dinheiro: o Pix cobra exatamente o total do pedido', () => {
  it('o campo de valor do BR Code reconstrói os centavos, para 20000 valores', () => {
    const r = rng(42);
    const edge = [1, 5, 9, 10, 99, 100, 101, 999, 1000, 1007, 2990, 10_007, 99_999_999];
    const values = [...edge, ...Array.from({ length: 20_000 }, () => int(r, 1, 99_999_999))];
    for (const cents of values) {
      const code = buildPixBrCode({
        key: '288a4ab6-8586-465b-b57d-ce3991eb4193',
        merchantName: 'Loja',
        merchantCity: 'Natal',
        amountCents: cents,
        txid: '1001',
      });
      const amount = parseEmv(code)['54']!;
      // Reconstrução exata por string — sem passar por ponto flutuante.
      const [reais, centavos] = amount.split('.');
      expect(centavos).toHaveLength(2);
      expect(Number(reais) * 100 + Number(centavos)).toBe(cents);
      expect(amount).toBe(centsToEmvAmount(cents));
      expect(validateBrCodeChecksum(code)).toBe(true);
      expect(code.length).toBeLessThanOrEqual(512);
    }
  });

  it('o CRC detecta qualquer alteração de um único caractere no valor', () => {
    const code = buildPixBrCode({
      key: '288a4ab6-8586-465b-b57d-ce3991eb4193',
      merchantName: 'Loja',
      merchantCity: 'Natal',
      amountCents: 2990,
      txid: '1001',
    });
    const at = code.indexOf('29.90');
    for (let i = 0; i < 5; i++) {
      if (code[at + i] === '.') continue;
      const tampered = code.slice(0, at + i) + (code[at + i] === '9' ? '1' : '9') + code.slice(at + i + 1);
      expect(validateBrCodeChecksum(tampered)).toBe(false);
    }
  });

  it('normalizar a chave é idempotente e nunca produz máscara', () => {
    const samples: Array<['CPF' | 'CNPJ' | 'PHONE' | 'EMAIL' | 'RANDOM', string]> = [
      ['CPF', '529.982.247-25'],
      ['CNPJ', '11.222.333/0001-81'],
      ['PHONE', '(84) 99999-1234'],
      ['PHONE', '+55 (84) 99999-1234'],
      ['EMAIL', ' Loja@Exemplo.COM '],
      ['RANDOM', '288A4AB6-8586-465B-B57D-CE3991EB4193'],
    ];
    for (const [type, raw] of samples) {
      const once = normalizePixKey(type, raw);
      expect(normalizePixKey(type, once)).toBe(once);
      expect(once).not.toMatch(/[()\s]/);
    }
  });
});

describe('dinheiro: exibição', () => {
  it('formatBRL reconstrói exatamente os centavos, para 5000 valores', () => {
    const r = rng(99);
    for (let n = 0; n < 5000; n++) {
      const cents = int(r, 0, 999_999_999);
      const shown = formatBRL(cents); // ex.: "R$ 1.234,56"
      const digits = shown.replace(/\D/g, '');
      expect(Number(digits)).toBe(cents);
      expect(shown).toMatch(/^R\$ [\d.]+,\d{2}$/);
    }
  });

  it('formatBRL de negativo mantém o sinal e o valor', () => {
    expect(formatBRL(-1250)).toBe('-R$ 12,50');
  });
});
