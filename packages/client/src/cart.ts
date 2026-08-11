import { priceOrder, type PricingResult } from '@plataforma/domain';
import type { MenuProduct, ModifierGroup } from './api.js';

/**
 * Carrinho local (item 5 do Prompt 02).
 *
 * O total exibido aqui usa a MESMA função `priceOrder` do servidor — o pacote
 * `@plataforma/domain` é compartilhado. Isso garante que o valor mostrado na
 * tela e o valor cobrado sejam calculados pela mesma regra.
 *
 * Ainda assim, este total é APENAS EXIBIÇÃO. No checkout ele vai como
 * `expectedTotalCents`, e o servidor recalcula do zero: se divergir, o pedido
 * é recusado com 409 e o app pede confirmação do novo valor. O app mostra; o
 * servidor cobra.
 */

export interface CartOption {
  id: string;
  name: string;
  priceDeltaCents: number;
  groupName: string;
}

export interface CartLine {
  /** Chave local: mesmo produto com adicionais diferentes são linhas distintas. */
  key: string;
  productId: string;
  name: string;
  imageUrl: string | null;
  unitPriceCents: number;
  quantity: number;
  options: CartOption[];
  notes?: string;
  /** Quantidade máxima quando o produto controla estoque. */
  maxQuantity: number | null;
}

export interface CartState {
  branchId: string | null;
  organizationSlug: string | null;
  branchSlug: string | null;
  lines: CartLine[];
}

export const EMPTY_CART: CartState = {
  branchId: null,
  organizationSlug: null,
  branchSlug: null,
  lines: [],
};

function lineKey(productId: string, optionIds: string[], notes?: string): string {
  return [productId, [...optionIds].sort().join('|'), notes ?? ''].join('::');
}

export function addToCart(
  cart: CartState,
  input: {
    product: MenuProduct;
    branchId: string;
    organizationSlug: string;
    branchSlug: string;
    quantity: number;
    selectedOptions: CartOption[];
    notes?: string;
  },
): CartState {
  // Trocar de loja limpa o carrinho: um pedido pertence a UMA unidade.
  const base =
    cart.branchId && cart.branchId !== input.branchId
      ? { ...EMPTY_CART, branchId: input.branchId }
      : cart;

  const key = lineKey(
    input.product.id,
    input.selectedOptions.map((o) => o.id),
    input.notes,
  );
  const existing = base.lines.find((l) => l.key === key);
  const maxQuantity = input.product.availability.availableQuantity;

  const lines = existing
    ? base.lines.map((l) =>
        l.key === key ? { ...l, quantity: clamp(l.quantity + input.quantity, maxQuantity) } : l,
      )
    : [
        ...base.lines,
        {
          key,
          productId: input.product.id,
          name: input.product.name,
          imageUrl: input.product.thumbUrl ?? input.product.imageUrl,
          unitPriceCents: input.product.priceCents,
          quantity: clamp(input.quantity, maxQuantity),
          options: input.selectedOptions,
          notes: input.notes,
          maxQuantity,
        },
      ];

  return {
    branchId: input.branchId,
    organizationSlug: input.organizationSlug,
    branchSlug: input.branchSlug,
    lines,
  };
}

export function changeQuantity(cart: CartState, key: string, delta: number): CartState {
  const lines = cart.lines
    .map((l) => (l.key === key ? { ...l, quantity: clamp(l.quantity + delta, l.maxQuantity) } : l))
    .filter((l) => l.quantity > 0);
  return lines.length === 0 ? { ...EMPTY_CART } : { ...cart, lines };
}

export function removeLine(cart: CartState, key: string): CartState {
  const lines = cart.lines.filter((l) => l.key !== key);
  return lines.length === 0 ? { ...EMPTY_CART } : { ...cart, lines };
}

export function clearCart(): CartState {
  return { ...EMPTY_CART };
}

export function cartItemCount(cart: CartState): number {
  return cart.lines.reduce((acc, l) => acc + l.quantity, 0);
}

/** Total previsto. O valor cobrado é sempre o recalculado pelo servidor. */
export function priceCart(cart: CartState, deliveryFeeCents = 0): PricingResult | null {
  if (cart.lines.length === 0) return null;
  return priceOrder({
    items: cart.lines.map((l) => ({
      unitPriceCents: l.unitPriceCents,
      quantity: l.quantity,
      options: l.options.map((o) => ({ priceDeltaCents: o.priceDeltaCents, quantity: 1 })),
    })),
    deliveryFeeCents,
    discountCents: 0,
  });
}

export function toOrderItems(cart: CartState) {
  return cart.lines.map((l) => ({
    productId: l.productId,
    quantity: l.quantity,
    optionIds: l.options.map((o) => o.id),
    notes: l.notes,
  }));
}

/** Valida os grupos obrigatórios antes de deixar adicionar ao carrinho. */
export function validateSelection(
  groups: ModifierGroup[],
  selectedIds: string[],
): { ok: true } | { ok: false; message: string } {
  for (const group of groups) {
    const count = group.options.filter((o) => selectedIds.includes(o.id)).length;
    if (group.isRequired && count < Math.max(1, group.minSelect)) {
      return { ok: false, message: `Escolha ao menos ${Math.max(1, group.minSelect)} em "${group.name}"` };
    }
    if (count > group.maxSelect) {
      return { ok: false, message: `"${group.name}" aceita no máximo ${group.maxSelect}` };
    }
  }
  return { ok: true };
}

function clamp(quantity: number, max: number | null): number {
  const bounded = Math.max(0, Math.min(quantity, 999));
  return max === null ? bounded : Math.min(bounded, max);
}
