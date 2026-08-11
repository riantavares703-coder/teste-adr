-- =============================================================================
--  ROW LEVEL SECURITY — segunda camada de isolamento multi-tenant.
--
--  A primeira camada é o guard de escopo na aplicação. Estas políticas existem
--  para que um `WHERE branch_id` esquecido em QUALQUER consulta futura deixe de
--  ser vazamento entre franquias e passe a ser resultado vazio.
--
--  Deriva de docs/sql/rls-policies.sql.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public, app TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Append-only: a aplicação insere e lê, mas não altera nem apaga.
REVOKE UPDATE, DELETE ON audit_logs, order_status_history,
                          inventory_movements, payment_events FROM app_user;

-- -----------------------------------------------------------------------------
-- Contexto da requisição (definido com SET LOCAL dentro da transação)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid; $$;

CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid; $$;

CREATE OR REPLACE FUNCTION app.current_user_type() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('app.user_type', true), ''), 'NONE'); $$;

CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.is_platform_admin', true), 'off') = 'on'; $$;

CREATE OR REPLACE FUNCTION app.branch_in_scope(target_branch_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE raw_scope text := COALESCE(current_setting('app.branch_scope', true), '');
BEGIN
    IF app.is_platform_admin() THEN RETURN true; END IF;
    IF raw_scope = '' THEN RETURN true; END IF;  -- escopo de organização inteira
    IF target_branch_id IS NULL THEN RETURN true; END IF;
    RETURN target_branch_id::text = ANY (string_to_array(raw_scope, ','));
END; $$;

CREATE OR REPLACE FUNCTION app.tenant_visible(org_id uuid, br_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT app.is_platform_admin()
        OR (org_id = app.current_org_id() AND app.branch_in_scope(br_id));
$$;

-- -----------------------------------------------------------------------------
-- Políticas
-- -----------------------------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_isolation ON organizations
    USING (app.is_platform_admin() OR id = app.current_org_id())
    WITH CHECK (app.is_platform_admin());

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
CREATE POLICY branches_isolation ON branches
    USING (app.tenant_visible(organization_id, id))
    WITH CHECK (app.tenant_visible(organization_id, id));

-- Tabelas com organization_id + branch_id: mesmo predicado
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'store_settings','branding_settings','pix_settings','business_hours',
        'categories','products','modifier_groups','delivery_zones',
        'virtual_inventory','inventory_movements','inventory_reservations',
        'deliveries','notifications'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY %1$I_isolation ON %1$I
                USING (app.tenant_visible(organization_id, branch_id))
                WITH CHECK (app.tenant_visible(organization_id, branch_id))
        $f$, t);
    END LOOP;
END $$;

-- Filhas sem organization_id próprio: herdam do pai via EXISTS
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images FORCE ROW LEVEL SECURITY;
CREATE POLICY product_images_isolation ON product_images
    USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_images.product_id))
    WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_images.product_id));

ALTER TABLE modifier_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_options FORCE ROW LEVEL SECURITY;
CREATE POLICY modifier_options_isolation ON modifier_options
    USING (EXISTS (SELECT 1 FROM modifier_groups g WHERE g.id = modifier_options.modifier_group_id))
    WITH CHECK (EXISTS (SELECT 1 FROM modifier_groups g WHERE g.id = modifier_options.modifier_group_id));

ALTER TABLE product_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_modifier_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY product_modifier_groups_isolation ON product_modifier_groups
    USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_modifier_groups.product_id))
    WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_modifier_groups.product_id));

-- PEDIDOS: duas classes legítimas de acesso, mutuamente exclusivas.
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_staff_isolation ON orders FOR ALL
    USING (app.current_user_type() = 'STAFF' AND app.tenant_visible(organization_id, branch_id))
    WITH CHECK (app.current_user_type() = 'STAFF' AND app.tenant_visible(organization_id, branch_id));
CREATE POLICY orders_customer_isolation ON orders FOR ALL
    USING (app.current_user_type() = 'CUSTOMER' AND customer_id = app.current_user_id())
    WITH CHECK (app.current_user_type() = 'CUSTOMER' AND customer_id = app.current_user_id());

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['order_items','order_status_history','payments'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY %1$I_isolation ON %1$I
                USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = %1$I.order_id))
                WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = %1$I.order_id))
        $f$, t);
    END LOOP;
END $$;

ALTER TABLE order_item_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_options FORCE ROW LEVEL SECURITY;
CREATE POLICY order_item_options_isolation ON order_item_options
    USING (EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = order_item_options.order_item_id))
    WITH CHECK (EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = order_item_options.order_item_id));

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_events_isolation ON payment_events
    USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_events.payment_id))
    WITH CHECK (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_events.payment_id));

-- USUÁRIOS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users USING (id = app.current_user_id());
CREATE POLICY users_staff_same_org ON users
    USING (app.current_user_type() = 'STAFF' AND type = 'STAFF' AND organization_id = app.current_org_id());
CREATE POLICY users_customers_of_org ON users
    USING (app.current_user_type() = 'STAFF' AND type = 'CUSTOMER'
           AND EXISTS (SELECT 1 FROM customer_organization_links col
                       WHERE col.customer_id = users.id AND col.organization_id = app.current_org_id()));
CREATE POLICY users_platform_admin ON users USING (app.is_platform_admin());
-- Escrita de usuário passa pelo serviço de identidade, que roda com contexto
-- de plataforma; a política de INSERT é restritiva por padrão.
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (app.is_platform_admin());

-- user_roles: a tabela que DEFINE a autorização precisa ela mesma ser isolada.
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_self_read ON user_roles FOR SELECT USING (user_id = app.current_user_id());
CREATE POLICY user_roles_org_isolation ON user_roles FOR ALL
    USING (app.is_platform_admin()
           OR (app.current_user_type() = 'STAFF' AND organization_id = app.current_org_id()
               AND (branch_id IS NULL OR app.branch_in_scope(branch_id))))
    WITH CHECK (app.is_platform_admin()
           OR (app.current_user_type() = 'STAFF' AND organization_id = app.current_org_id()
               AND (branch_id IS NULL OR app.branch_in_scope(branch_id))));

ALTER TABLE delivery_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_addresses_owner ON delivery_addresses
    USING (customer_id = app.current_user_id())
    WITH CHECK (customer_id = app.current_user_id());
CREATE POLICY delivery_addresses_staff_by_order ON delivery_addresses FOR SELECT
    USING (app.current_user_type() = 'STAFF'
           AND EXISTS (SELECT 1 FROM orders o WHERE o.delivery_address_id = delivery_addresses.id));

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['sessions','mfa_credentials','device_tokens','customer_organization_links'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;

CREATE POLICY sessions_owner ON sessions
    USING (user_id = app.current_user_id() OR app.is_platform_admin())
    WITH CHECK (user_id = app.current_user_id() OR app.is_platform_admin());
CREATE POLICY mfa_credentials_owner ON mfa_credentials
    USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
CREATE POLICY device_tokens_owner ON device_tokens
    USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
CREATE POLICY customer_org_links_visibility ON customer_organization_links
    USING (customer_id = app.current_user_id()
           OR app.is_platform_admin()
           OR (app.current_user_type() = 'STAFF' AND organization_id = app.current_org_id()))
    WITH CHECK (customer_id = app.current_user_id()
           OR app.is_platform_admin()
           OR (app.current_user_type() = 'STAFF' AND organization_id = app.current_org_id()));

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_read ON audit_logs FOR SELECT
    USING (app.is_platform_admin() OR organization_id = app.current_org_id());
-- Nunca se pode impedir o registro de um evento de segurança.
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (true);

ALTER TABLE whatsapp_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_integrations_isolation ON whatsapp_integrations
    USING (app.is_platform_admin() OR organization_id = app.current_org_id())
    WITH CHECK (app.is_platform_admin() OR organization_id = app.current_org_id());

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY media_assets_isolation ON media_assets
    USING (app.is_platform_admin() OR organization_id = app.current_org_id())
    WITH CHECK (app.is_platform_admin() OR organization_id = app.current_org_id());

-- -----------------------------------------------------------------------------
-- Conformidade: falha o CI se uma tabela multi-tenant ficar sem RLS.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_rls_coverage() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE missing text;
BEGIN
    SELECT string_agg(c.relname, ', ') INTO missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
      AND c.relname NOT IN (
          'roles','permissions','role_permissions','outbox_events',
          'idempotency_keys','login_attempts','otp_codes',
          'order_number_counters','_migrations'
      );
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Tabelas sem RLS habilitada: %', missing;
    END IF;
END; $$;
