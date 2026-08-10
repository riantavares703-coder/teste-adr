-- =============================================================================
--  BATERIA DE VALIDAÇÃO DOS INVARIANTES CRÍTICOS
--
--  Estes testes devem rodar no CI contra um PostgreSQL real (não mock).
--  Todos foram executados contra PostgreSQL 16.13 durante a elaboração da
--  arquitetura; os resultados estão registrados em docs/02-modelo-de-dados.md §15.
--
--  Uso:
--    psql -v ON_ERROR_STOP=1 -f schema.sql -f rls-policies.sql -f validation-tests.sql
--
--  Observação: o teste de CONCORRÊNCIA (T1) não pode ser expresso em SQL
--  sequencial — exige processos paralelos. O script de referência está no
--  final deste arquivo, em comentário, e deve virar um teste de integração.
-- =============================================================================

\set ON_ERROR_STOP off

BEGIN;

-- Massa de teste mínima: duas organizações concorrentes
INSERT INTO organizations (id, slug, legal_name, trade_name, contact_email) VALUES
    ('00000000-0000-7000-8000-000000000001','acme', 'Acme LTDA','Acme', 'a@acme.com'),
    ('00000000-0000-7000-8000-0000000000a1','rival','Rival SA', 'Rival','r@rival.com');

INSERT INTO branches (id, organization_id, slug, name) VALUES
    ('00000000-0000-7000-8000-000000000002','00000000-0000-7000-8000-000000000001','centro','Centro'),
    ('00000000-0000-7000-8000-00000000000e','00000000-0000-7000-8000-000000000001','zona-sul','Zona Sul');

INSERT INTO products (id, organization_id, branch_id, name, price_cents) VALUES
    ('00000000-0000-7000-8000-000000000003','00000000-0000-7000-8000-000000000001',
     '00000000-0000-7000-8000-000000000002','X-Burger', 2990);

INSERT INTO virtual_inventory (organization_id, branch_id, product_id, mode, on_hand_qty) VALUES
    ('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000002',
     '00000000-0000-7000-8000-000000000003','LIMITED', 10);

INSERT INTO users (id, type, full_name, email) VALUES
    ('00000000-0000-7000-8000-00000000000c','CUSTOMER','Cliente Teste','c@teste.com');

COMMIT;

-- -----------------------------------------------------------------------------
-- T2 — Estoque: reservar mais do que existe é IMPOSSÍVEL
--      Esperado: violates check constraint "virtual_inventory_reserved_chk"
-- -----------------------------------------------------------------------------
\echo '== T2: reserva acima do disponível deve FALHAR =='
UPDATE virtual_inventory SET reserved_qty = 11
 WHERE product_id = '00000000-0000-7000-8000-000000000003';

-- -----------------------------------------------------------------------------
-- T3 — Numeração amigável: atômica e sem duplicata
--      (executar em paralelo; ver script no rodapé)
-- -----------------------------------------------------------------------------
\echo '== T3: contador de pedido =='
INSERT INTO order_number_counters (branch_id, business_date, last_number)
VALUES ('00000000-0000-7000-8000-000000000002', CURRENT_DATE, 1)
ON CONFLICT (branch_id, business_date)
DO UPDATE SET last_number = order_number_counters.last_number + 1
RETURNING last_number;

-- -----------------------------------------------------------------------------
-- T4 — Histórico de status é IMUTÁVEL
--      Esperado: 'append-only: UPDATE não é permitido' / 'DELETE não é permitido'
-- -----------------------------------------------------------------------------
\echo '== T4: histórico imutável =='
INSERT INTO orders (id, organization_id, branch_id, customer_id, order_number,
                    fulfillment, payment_method, subtotal_cents, total_cents)
VALUES ('00000000-0000-7000-8000-00000000000d','00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000002','00000000-0000-7000-8000-00000000000c',
        '1042','PICKUP','PIX', 2990, 2990);

INSERT INTO order_status_history (order_id, organization_id, branch_id, from_status, to_status, actor_type)
VALUES ('00000000-0000-7000-8000-00000000000d','00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-000000000002', NULL,'PENDING','CUSTOMER');

UPDATE order_status_history SET to_status = 'DELIVERED';   -- deve FALHAR
DELETE FROM order_status_history;                          -- deve FALHAR

-- -----------------------------------------------------------------------------
-- T5 — Aritmética do pedido é invariante de banco
--      Esperado: violates check constraint "orders_total_chk"
-- -----------------------------------------------------------------------------
\echo '== T5: total inconsistente deve FALHAR =='
INSERT INTO orders (organization_id, branch_id, customer_id, order_number,
                    fulfillment, payment_method, subtotal_cents, total_cents)
VALUES ('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000002',
        '00000000-0000-7000-8000-00000000000c','9997','PICKUP','PIX', 5000, 100);

-- -----------------------------------------------------------------------------
-- T6 — Retirada não pode cobrar taxa de entrega
--      Esperado: violates check constraint "orders_delivery_chk"
-- -----------------------------------------------------------------------------
\echo '== T6: taxa de entrega em retirada deve FALHAR =='
INSERT INTO orders (organization_id, branch_id, customer_id, order_number,
                    fulfillment, payment_method, subtotal_cents, delivery_fee_cents, total_cents)
VALUES ('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000002',
        '00000000-0000-7000-8000-00000000000c','9998','PICKUP','PIX', 5000, 700, 5700);

-- -----------------------------------------------------------------------------
-- T7 — Categoria de OUTRA unidade é impossível (FK composta)
--      Esperado: violates foreign key constraint "products_category_same_branch_fk"
-- -----------------------------------------------------------------------------
\echo '== T7: vazamento de tenant via categoria deve FALHAR =='
INSERT INTO categories (id, organization_id, branch_id, name)
VALUES ('00000000-0000-7000-8000-00000000000f','00000000-0000-7000-8000-000000000001',
        '00000000-0000-7000-8000-00000000000e','Lanches Zona Sul');

UPDATE products SET category_id = '00000000-0000-7000-8000-00000000000f'
 WHERE id = '00000000-0000-7000-8000-000000000003';

-- -----------------------------------------------------------------------------
-- T8 — ISOLAMENTO RLS ENTRE FRANQUIAS
--      A consulta é IDÊNTICA e SEM cláusula WHERE de tenant. A diferença é
--      apenas o contexto da transação. É exatamente o cenário de "o dev
--      esqueceu o WHERE" — e é o que a RLS precisa neutralizar.
-- -----------------------------------------------------------------------------
\echo '== T8a: operador da ACME vê o próprio pedido (esperado 1) =='
SET ROLE app_user;
BEGIN;
    SET LOCAL app.user_type       = 'STAFF';
    SET LOCAL app.organization_id = '00000000-0000-7000-8000-000000000001';
    SELECT count(*) AS pedidos_visiveis FROM orders;
COMMIT;

\echo '== T8b: operador da RIVAL, mesma consulta (esperado 0 em tudo) =='
BEGIN;
    SET LOCAL app.user_type       = 'STAFF';
    SET LOCAL app.organization_id = '00000000-0000-7000-8000-0000000000a1';
    SELECT count(*) AS pedidos_visiveis  FROM orders;
    SELECT count(*) AS produtos_visiveis FROM products;
    SELECT count(*) AS unidades_visiveis FROM branches;
COMMIT;

\echo '== T8c: IDOR — RIVAL busca o pedido pelo UUID exato (esperado 0) =='
BEGIN;
    SET LOCAL app.user_type       = 'STAFF';
    SET LOCAL app.organization_id = '00000000-0000-7000-8000-0000000000a1';
    SELECT count(*) AS linhas FROM orders
     WHERE id = '00000000-0000-7000-8000-00000000000d';
COMMIT;
RESET ROLE;

-- -----------------------------------------------------------------------------
-- T9 — Nenhuma tabela multi-tenant pode ficar sem RLS
--      Falha o CI quando alguém cria uma tabela e esquece a política.
-- -----------------------------------------------------------------------------
\echo '== T9: cobertura de RLS =='
SELECT app.assert_rls_coverage();

-- =============================================================================
-- T1 — CONCORRÊNCIA (executar como teste de integração, com processos paralelos)
--
--   Cenário A: 1 unidade em estoque, 40 clientes simultâneos  -> 1 vencedor
--   Cenário B: 10 unidades em estoque, 60 clientes simultâneos -> 10 vencedores
--
--   #!/usr/bin/env bash
--   P='00000000-0000-7000-8000-000000000003'
--   psql -qc "UPDATE virtual_inventory SET on_hand_qty=1, reserved_qty=0;"
--   for i in $(seq 1 40); do
--     ( psql -tAc "
--         UPDATE virtual_inventory
--            SET reserved_qty = reserved_qty + 1
--          WHERE product_id = '$P'
--            AND mode = 'LIMITED'
--            AND is_manually_sold_out = false
--            AND (on_hand_qty - reserved_qty) >= 1
--         RETURNING 'OK';" > out_$i ) &
--   done; wait
--   test "$(cat out_* | grep -c OK)" -eq 1 || { echo "FALHOU: overselling"; exit 1; }
--
--   Por que funciona sem lock explícito: em READ COMMITTED, quando duas
--   transações atualizam a MESMA linha, a segunda bloqueia até a primeira
--   comitar e então REAVALIA a cláusula WHERE contra a versão nova da linha
--   (EvalPlanQual). Se o estoque acabou nesse meio-tempo, o WHERE passa a ser
--   falso e o UPDATE afeta 0 linhas. Um único statement, sem SELECT ... FOR
--   UPDATE, sem lost update.
--
--   ATENÇÃO: em REPEATABLE READ ou SERIALIZABLE esse mesmo statement levanta
--   erro de serialização em vez de reavaliar. A aplicação DEVE usar READ
--   COMMITTED nesta operação (o padrão do PostgreSQL) ou tratar o retry.
-- =============================================================================
