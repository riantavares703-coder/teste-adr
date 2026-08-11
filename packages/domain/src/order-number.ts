/**
 * Número amigável do pedido (#1042).
 *
 * O UUID é o identificador técnico; este é o identificador HUMANO — ninguém
 * dita um UUID por telefone. É único POR UNIDADE (nunca global), então duas
 * unidades podem ter #1042 no mesmo dia e o volume da rede não vaza.
 *
 * A geração atômica acontece no banco, via
 *   INSERT ... ON CONFLICT (branch_id, business_date) DO UPDATE
 *   SET last_number = last_number + 1 RETURNING last_number
 * (ver apps/api/src/modules/ordering/order-number.repository.ts).
 * Este módulo cuida apenas da formatação e da data de operação.
 */

export const ORDER_NUMBER_START = 1000;

/** Formata o contador como número amigável, iniciando em #1001. */
export function formatOrderNumber(counter: number): string {
  if (!Number.isInteger(counter) || counter < 1) {
    throw new Error(`Contador de pedido inválido: ${counter}`);
  }
  return String(ORDER_NUMBER_START + counter);
}

export function displayOrderNumber(orderNumber: string): string {
  return `#${orderNumber}`;
}

/**
 * Data de operação da unidade no fuso dela.
 *
 * Usar `new Date().toISOString().slice(0,10)` seria errado: às 21h de Manaus
 * (UTC-4) já é o dia seguinte em UTC, e o contador da loja viraria no meio do
 * expediente.
 */
export function businessDateFor(instant: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(instant); // en-CA formata como YYYY-MM-DD
}
