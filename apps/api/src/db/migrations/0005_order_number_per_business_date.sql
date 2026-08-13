-- =============================================================================
--  NÚMERO AMIGÁVEL: ÚNICO POR DIA DE OPERAÇÃO, NÃO PARA SEMPRE
--
--  order_number_counters reinicia por (branch_id, business_date) de propósito
--  — é o que mantém o número curto ("pedido 12!") em vez de crescer sem fim
--  ao longo dos meses. Mas o índice de unicidade de `orders` era só
--  (branch_id, order_number), sem a data: o primeiro pedido de QUALQUER dia
--  seguinte gera #1001 de novo e colide com o #1001 de ontem. Toda unidade
--  real bateria nisso já no segundo dia de uso.
-- =============================================================================

ALTER TABLE orders ADD COLUMN business_date date;

-- Backfill pelo fuso da PRÓPRIA unidade, não UTC: é o mesmo cálculo que
-- `businessDateFor` faz na aplicação (packages/domain/src/order-number.ts).
UPDATE orders o
SET business_date = (o.placed_at AT TIME ZONE b.timezone)::date
FROM branches b
WHERE b.id = o.branch_id;

ALTER TABLE orders ALTER COLUMN business_date SET NOT NULL;

DROP INDEX orders_branch_number_uk;
CREATE UNIQUE INDEX orders_branch_number_uk ON orders (branch_id, business_date, order_number);
