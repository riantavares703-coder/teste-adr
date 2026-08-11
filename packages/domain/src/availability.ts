/**
 * Disponibilidade de produto (estoque virtual).
 *
 * `available_quantity` (item 3 do Prompt 02) é DERIVADO — nunca armazenado:
 *   available = on_hand_qty - reserved_qty
 *
 * Armazenar o derivado criaria uma terceira fonte de verdade para divergir das
 * outras duas. Ver docs/05-fluxo-de-estoque-virtual.md §1.
 */

export const AVAILABILITY_MODE = ['INFINITE', 'LIMITED'] as const;
export type AvailabilityMode = (typeof AVAILABILITY_MODE)[number];

export interface InventorySnapshot {
  readonly mode: AvailabilityMode;
  readonly onHandQty: number;
  readonly reservedQty: number;
  readonly isManuallySoldOut: boolean;
}

export type AvailabilityStatus = 'AVAILABLE' | 'SOLD_OUT' | 'MANUALLY_SOLD_OUT';

export interface AvailabilityView {
  readonly status: AvailabilityStatus;
  readonly isPurchasable: boolean;
  /** null quando o produto não controla quantidade (modo INFINITE). */
  readonly availableQuantity: number | null;
}

/**
 * Ordem de resolução (a decisão humana vence a quantidade):
 *   1. esgotado manualmente -> INDISPONÍVEL
 *   2. modo INFINITE        -> DISPONÍVEL
 *   3. modo LIMITED         -> disponível se (on_hand - reserved) > 0
 */
export function resolveAvailability(inv: InventorySnapshot): AvailabilityView {
  if (inv.isManuallySoldOut) {
    return {
      status: 'MANUALLY_SOLD_OUT',
      isPurchasable: false,
      availableQuantity: inv.mode === 'LIMITED' ? computeAvailable(inv) : null,
    };
  }

  if (inv.mode === 'INFINITE') {
    return { status: 'AVAILABLE', isPurchasable: true, availableQuantity: null };
  }

  const available = computeAvailable(inv);
  return available > 0
    ? { status: 'AVAILABLE', isPurchasable: true, availableQuantity: available }
    : { status: 'SOLD_OUT', isPurchasable: false, availableQuantity: 0 };
}

export function computeAvailable(inv: InventorySnapshot): number {
  return Math.max(0, inv.onHandQty - inv.reservedQty);
}

/** Um produto LIMITED pode atender a quantidade pedida? */
export function canFulfill(inv: InventorySnapshot, quantity: number): boolean {
  const view = resolveAvailability(inv);
  if (!view.isPurchasable) return false;
  if (view.availableQuantity === null) return true; // INFINITE
  return view.availableQuantity >= quantity;
}

export function isLowStock(inv: InventorySnapshot, threshold: number | null): boolean {
  if (inv.mode !== 'LIMITED' || threshold === null) return false;
  return computeAvailable(inv) <= threshold;
}

export const AVAILABILITY_LABEL: Record<AvailabilityStatus, string> = {
  AVAILABLE: 'Disponível',
  SOLD_OUT: 'Esgotado',
  MANUALLY_SOLD_OUT: 'Esgotado (manual)',
};
