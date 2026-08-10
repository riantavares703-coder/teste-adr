-- =============================================================================
--  ISOLAMENTO MULTI-TENANT — ROW LEVEL SECURITY
--  Aplicar DEPOIS de docs/sql/schema.sql
--
--  Esta é a SEGUNDA camada de isolamento. A primeira é o guard de escopo na
--  aplicação (docs/06-modelo-de-permissoes.md). Elas são redundantes de
--  propósito: um `WHERE branch_id` esquecido em qualquer consulta futura deixa
--  de ser um vazamento de dados entre franquias e passa a ser um resultado
--  vazio. Nenhuma das duas camadas confia na outra.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Papéis de banco
-- -----------------------------------------------------------------------------
-- A aplicação NUNCA conecta como superusuário nem como dono das tabelas —
-- o dono das tabelas ignora RLS por padrão, o que anularia todo este arquivo.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
        CREATE ROLE app_migrator NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_readonly') THEN
        CREATE ROLE app_readonly NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public, app TO app_user, app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_readonly;

-- Tabelas append-only: a aplicação insere e lê, mas NÃO pode alterar nem apagar.
-- Defesa em profundidade junto com os triggers app.forbid_mutation().
REVOKE UPDATE, DELETE ON audit_logs, order_status_history,
                          inventory_movements, payment_events FROM app_user;

-- -----------------------------------------------------------------------------
-- 2. Contexto de requisição
-- -----------------------------------------------------------------------------
-- A API abre uma transação e define estas variáveis com SET LOCAL antes de
-- qualquer consulta. SET LOCAL vale só até o COMMIT/ROLLBACK, o que torna o
-- padrão seguro com PgBouncer em modo `transaction`.
--
--   SET LOCAL app.user_id           = '<uuid>';
--   SET LOCAL app.user_type         = 'STAFF' | 'CUSTOMER';
--   SET LOCAL app.organization_id   = '<uuid>';
--   SET LOCAL app.branch_scope      = '<uuid>,<uuid>,...';  -- vazio = toda a org
--   SET LOCAL app.is_platform_admin = 'on' | 'off';

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_user_type() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('app.user_type', true), ''), 'NONE');
$$;

-- SUPER_ADMIN não "escapa" silenciosamente do isolamento: o bypass é uma decisão
-- explícita da aplicação, sempre acompanhada de registro em audit_logs.
CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on';
$$;

-- Escopo de unidades. Lista vazia = acesso a todas as unidades da organização
-- (FRANCHISE_ADMIN). Lista preenchida = apenas as unidades concedidas.
CREATE OR REPLACE FUNCTION app.branch_in_scope(target_branch_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
    raw_scope text := COALESCE(current_setting('app.branch_scope', true), '');
BEGIN
    IF app.is_platform_admin() THEN
        RETURN true;
    END IF;
    IF raw_scope = '' THEN
        RETURN true;   -- escopo de organização inteira; a política de org já filtrou
    END IF;
    RETURN target_branch_id::text = ANY (string_to_array(raw_scope, ','));
END;
$$;

-- Predicado padrão das tabelas com organization_id + branch_id
CREATE OR REPLACE FUNCTION app.tenant_visible(org_id uuid, br_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT app.is_platform_admin()
        OR (org_id = app.current_org_id() AND app.branch_in_scope(br_id));
$$;

-- -----------------------------------------------------------------------------
-- 3. Políticas
-- -----------------------------------------------------------------------------
-- FORCE ROW LEVEL SECURITY garante que nem o dono da tabela escape das políticas.

-- 3.1 Organizações
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;
CREATE POLICY organizations_isolation ON organizations
    USING (app.is_platform_admin() OR id = app.current_org_id())
    WITH CHECK (app.is_platform_admin());     -- só a plataforma cria/edita organização

-- 3.2 Unidades
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE  ROW LEVEL SECURITY;
CREATE POLICY branches_isolation ON branches
    USING (app.tenant_visible(organization_id, id))
    WITH CHECK (app.tenant_visible(organization_id, id));

-- 3.3 Tabelas de configuração ligadas à unidade
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['store_settings','branding_settings','pix_settings','business_hours']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY %1$I_isolation ON %1$I
                USING (app.tenant_visible(organization_id, branch_id))
                WITH CHECK (app.tenant_visible(organization_id, branch_id))
        $f$, t);
    END LOOP;
END $$;

-- 3.4 Catálogo, estoque, entrega e plataforma: mesmo predicado (org + unidade)
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'categories','products','modifier_groups','delivery_zones',
        'virtual_inventory','inventory_movements','inventory_reservations',
        'deliveries','notifications'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY %1$I_isolation ON %1$I
                USING (app.tenant_visible(organization_id, branch_id))
                WITH CHECK (app.tenant_visible(organization_id, branch_id))
        $f$, t);
    END LOOP;
END $$;

-- 3.5 Tabelas filhas sem organization_id próprio: herdam via EXISTS no pai
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images FORCE  ROW LEVEL SECURITY;
CREATE POLICY product_images_isolation ON product_images
    USING (EXISTS (SELECT 1 FROM products p
                   WHERE p.id = product_images.product_id
                     AND app.tenant_visible(p.organization_id, p.branch_id)));

ALTER TABLE modifier_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_options FORCE  ROW LEVEL SECURITY;
CREATE POLICY modifier_options_isolation ON modifier_options
    USING (EXISTS (SELECT 1 FROM modifier_groups g
                   WHERE g.id = modifier_options.modifier_group_id
                     AND app.tenant_visible(g.organization_id, g.branch_id)));

-- 3.6 PEDIDOS — a política mais delicada do sistema.
-- Duas classes de acesso legítimo, mutuamente exclusivas:
--   (a) operação: usuário STAFF, dentro da organização e com a unidade em escopo;
--   (b) consumo:  usuário CUSTOMER, e SOMENTE os próprios pedidos.
-- O cliente é global à plataforma (compra em várias franquias), então não pode
-- ser filtrado por organization_id — é filtrado por identidade.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE  ROW LEVEL SECURITY;

CREATE POLICY orders_staff_isolation ON orders
    FOR ALL
    USING (
        app.current_user_type() = 'STAFF'
        AND app.tenant_visible(organization_id, branch_id)
    )
    WITH CHECK (
        app.current_user_type() = 'STAFF'
        AND app.tenant_visible(organization_id, branch_id)
    );

CREATE POLICY orders_customer_isolation ON orders
    FOR ALL
    USING (
        app.current_user_type() = 'CUSTOMER'
        AND customer_id = app.current_user_id()
    )
    WITH CHECK (
        app.current_user_type() = 'CUSTOMER'
        AND customer_id = app.current_user_id()
    );

-- Itens, histórico e pagamentos seguem a visibilidade do pedido pai.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['order_items','order_status_history','payments']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY %1$I_isolation ON %1$I
                USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = %1$I.order_id))
                WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = %1$I.order_id))
        $f$, t);
    END LOOP;
END $$;
-- O EXISTS acima é suficiente porque a própria consulta a `orders` já passa pela
-- RLS de orders: se o pedido não é visível, o EXISTS é falso.

ALTER TABLE order_item_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_options FORCE  ROW LEVEL SECURITY;
CREATE POLICY order_item_options_isolation ON order_item_options
    USING (EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = order_item_options.order_item_id));

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY payment_events_isolation ON payment_events
    USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_events.payment_id));

-- 3.7 Usuários
-- STAFF é visível dentro da própria organização; CUSTOMER só enxerga a si mesmo.
-- Um FRANCHISE_ADMIN NÃO pode listar clientes da plataforma — apenas quem pediu
-- na organização dele, e isso passa por customer_organization_links.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;

CREATE POLICY users_self ON users
    USING (id = app.current_user_id());

CREATE POLICY users_staff_same_org ON users
    USING (
        app.current_user_type() = 'STAFF'
        AND type = 'STAFF'
        AND organization_id = app.current_org_id()
    );

CREATE POLICY users_customers_of_org ON users
    USING (
        app.current_user_type() = 'STAFF'
        AND type = 'CUSTOMER'
        AND EXISTS (
            SELECT 1 FROM customer_organization_links col
            WHERE col.customer_id = users.id
              AND col.organization_id = app.current_org_id()
        )
    );

CREATE POLICY users_platform_admin ON users
    USING (app.is_platform_admin());

-- 3.7.1 Concessões de papel — a tabela que DEFINE a autorização precisa ela mesma
-- ser isolada, ou um bug permitiria ler (ou forjar) concessões de outra franquia.
-- Escrita adicional é barrada na aplicação: só quem tem 'role:assign' concede,
-- e nunca um papel de nível hierárquico igual ou superior ao próprio.
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE  ROW LEVEL SECURITY;

CREATE POLICY user_roles_self_read ON user_roles
    FOR SELECT
    USING (user_id = app.current_user_id());

CREATE POLICY user_roles_org_isolation ON user_roles
    FOR ALL
    USING (
        app.is_platform_admin()
        OR (app.current_user_type() = 'STAFF'
            AND organization_id = app.current_org_id()
            AND (branch_id IS NULL OR app.branch_in_scope(branch_id)))
    )
    WITH CHECK (
        app.is_platform_admin()
        OR (app.current_user_type() = 'STAFF'
            AND organization_id = app.current_org_id()
            AND (branch_id IS NULL OR app.branch_in_scope(branch_id)))
    );

-- 3.7.2 Vínculo produto ↔ grupo de adicionais: herda a visibilidade do produto.
ALTER TABLE product_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_modifier_groups FORCE  ROW LEVEL SECURITY;
CREATE POLICY product_modifier_groups_isolation ON product_modifier_groups
    USING (EXISTS (SELECT 1 FROM products p
                   WHERE p.id = product_modifier_groups.product_id))
    WITH CHECK (EXISTS (SELECT 1 FROM products p
                        WHERE p.id = product_modifier_groups.product_id));

-- 3.8 Endereços do cliente: do próprio cliente, ou da unidade que precisa entregar.
ALTER TABLE delivery_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_addresses FORCE  ROW LEVEL SECURITY;
CREATE POLICY delivery_addresses_owner ON delivery_addresses
    USING (customer_id = app.current_user_id())
    WITH CHECK (customer_id = app.current_user_id());
CREATE POLICY delivery_addresses_staff_by_order ON delivery_addresses
    FOR SELECT
    USING (
        app.current_user_type() = 'STAFF'
        AND EXISTS (SELECT 1 FROM orders o WHERE o.delivery_address_id = delivery_addresses.id)
    );

-- 3.9 Sessões e credenciais: exclusivamente do próprio usuário.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['sessions','mfa_credentials','device_tokens',
                             'password_reset_tokens','customer_organization_links']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    END LOOP;
END $$;

CREATE POLICY sessions_owner ON sessions
    USING (user_id = app.current_user_id() OR app.is_platform_admin())
    WITH CHECK (user_id = app.current_user_id());
CREATE POLICY mfa_credentials_owner ON mfa_credentials
    USING (user_id = app.current_user_id())
    WITH CHECK (user_id = app.current_user_id());
CREATE POLICY device_tokens_owner ON device_tokens
    USING (user_id = app.current_user_id())
    WITH CHECK (user_id = app.current_user_id());
CREATE POLICY password_reset_tokens_owner ON password_reset_tokens
    USING (user_id = app.current_user_id())
    WITH CHECK (user_id = app.current_user_id());
CREATE POLICY customer_org_links_visibility ON customer_organization_links
    USING (
        customer_id = app.current_user_id()
        OR (app.current_user_type() = 'STAFF' AND organization_id = app.current_org_id())
    );

-- 3.10 Auditoria: leitura restrita à organização; escrita sempre permitida
-- (nunca se pode impedir o registro de um evento de segurança).
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_logs_read ON audit_logs
    FOR SELECT
    USING (app.is_platform_admin() OR organization_id = app.current_org_id());
CREATE POLICY audit_logs_insert ON audit_logs
    FOR INSERT
    WITH CHECK (true);

-- 3.11 Integrações de WhatsApp
ALTER TABLE whatsapp_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_integrations FORCE  ROW LEVEL SECURITY;
CREATE POLICY whatsapp_integrations_isolation ON whatsapp_integrations
    USING (app.is_platform_admin() OR organization_id = app.current_org_id())
    WITH CHECK (app.is_platform_admin() OR organization_id = app.current_org_id());

-- -----------------------------------------------------------------------------
-- 4. Tabelas deliberadamente FORA da RLS
-- -----------------------------------------------------------------------------
--   roles, permissions, role_permissions  -> catálogo global, somente leitura
--   outbox_events, idempotency_keys       -> acessadas apenas por workers com
--                                            papel próprio (app_worker), nunca
--                                            por requisição de usuário
--   login_attempts, otp_codes             -> escritas antes de existir identidade;
--                                            leitura restrita por privilégio de tabela
-- Toda tabela nova precisa entrar nesta lista OU receber política — o teste
-- automatizado do item 5 falha o CI enquanto isso não acontecer.

-- -----------------------------------------------------------------------------
-- 5. Teste de conformidade (executado no CI)
-- -----------------------------------------------------------------------------
-- Falha o build se alguma tabela multi-tenant ficar sem RLS por esquecimento.
CREATE OR REPLACE FUNCTION app.assert_rls_coverage() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    missing text;
BEGIN
    SELECT string_agg(c.relname, ', ')
    INTO missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
      AND c.relname NOT IN (
          'roles','permissions','role_permissions','outbox_events',
          'idempotency_keys','login_attempts','otp_codes','media_assets',
          'order_number_counters','spatial_ref_sys'
      );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Tabelas sem RLS habilitada: %', missing;
    END IF;
END;
$$;

-- SELECT app.assert_rls_coverage();
