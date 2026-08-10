-- =============================================================================
--  PLATAFORMA MULTI-TENANT DE PEDIDOS — SCHEMA DE REFERÊNCIA
--  PostgreSQL 16+
--
--  Este arquivo é a especificação executável do modelo descrito em
--  docs/02-modelo-de-dados.md. As políticas de isolamento multi-tenant estão
--  em docs/sql/rls-policies.sql e devem ser aplicadas DEPOIS deste arquivo.
--
--  Convenções:
--    - PK  UUID (UUIDv7 gerado pela aplicação; fallback gen_random_uuid())
--    - Dinheiro em BIGINT de centavos + currency CHAR(3)
--    - Tempo em TIMESTAMPTZ (UTC)
--    - Soft delete via deleted_at (exceto tabelas de auditoria/financeiras)
--    - ON DELETE RESTRICT por padrão
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS citext;      -- e-mail/slug case-insensitive
CREATE EXTENSION IF NOT EXISTS postgis;     -- zonas de entrega e geolocalização
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- constraints de exclusão em horários

CREATE SCHEMA IF NOT EXISTS app;

-- PostgreSQL não traz range de `time`; criamos para impedir horários sobrepostos.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timerange') THEN
        CREATE TYPE timerange AS RANGE (subtype = time);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- UUIDv7: ordenável no tempo (localidade de índice) e não enumerável.
-- PostgreSQL 18 traz uuidv7() nativo; até lá, esta implementação.
-- -----------------------------------------------------------------------------
-- Parte-se de um UUIDv4 (que já traz a variante RFC 4122 correta), sobrescrevem-se
-- os 48 bits iniciais com o timestamp em milissegundos e ajusta-se o nibble de versão
-- de 0100 (v4) para 0111 (v7). Em bytea, set_bit numera os bits do MENOS significativo
-- ao mais significativo dentro de cada byte, então o nibble de versão são os bits
-- 52..55 e a conversão v4 -> v7 consiste em ligar os bits 52 e 53.
CREATE OR REPLACE FUNCTION app.uuid_generate_v7()
RETURNS uuid
LANGUAGE sql
VOLATILE
AS $$
    SELECT encode(
        set_bit(
            set_bit(
                overlay(
                    uuid_send(gen_random_uuid())
                    PLACING substring(
                        int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
                        FROM 3
                    )
                    FROM 1 FOR 6
                ),
                52, 1
            ),
            53, 1
        ),
        'hex'
    )::uuid;
$$;

-- Trigger genérico de updated_at
CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Trigger que torna uma tabela append-only (auditoria / histórico imutável)
CREATE OR REPLACE FUNCTION app.forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Tabela % é append-only: % não é permitido',
        TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- =============================================================================
-- 1. TIPOS ENUMERADOS
-- =============================================================================

CREATE TYPE org_status            AS ENUM ('ACTIVE','SUSPENDED','CANCELLED');
CREATE TYPE branch_status         AS ENUM ('ACTIVE','PAUSED','CLOSED_TEMPORARILY','ARCHIVED');
CREATE TYPE user_type             AS ENUM ('STAFF','CUSTOMER');
CREATE TYPE availability_mode     AS ENUM ('INFINITE','LIMITED');
CREATE TYPE movement_type         AS ENUM ('RESERVE','COMMIT','RELEASE','EXPIRE_RELEASE',
                                           'MANUAL_ADJUST','RESTOCK','SOLD_OUT_MANUAL',
                                           'REACTIVATE','RECONCILE');
CREATE TYPE reservation_status    AS ENUM ('ACTIVE','COMMITTED','RELEASED','EXPIRED');
CREATE TYPE fulfillment_type      AS ENUM ('PICKUP','DELIVERY');
CREATE TYPE order_status          AS ENUM ('PENDING','AWAITING_PAYMENT','CONFIRMED','PREPARING',
                                           'READY','AWAITING_PICKUP','OUT_FOR_DELIVERY',
                                           'DELIVERED','PICKED_UP','CANCELLED','REJECTED','EXPIRED');
CREATE TYPE payment_method        AS ENUM ('PIX','CREDIT_ON_SITE','DEBIT_ON_SITE','CASH_ON_SITE');
CREATE TYPE payment_status        AS ENUM ('PENDING','AWAITING_CONFIRMATION','CONFIRMED',
                                           'FAILED','REFUNDED','CANCELLED');
CREATE TYPE actor_type            AS ENUM ('CUSTOMER','STAFF','SYSTEM','WEBHOOK');
CREATE TYPE notification_channel  AS ENUM ('WHATSAPP','PUSH','EMAIL','SMS');
CREATE TYPE notification_status   AS ENUM ('QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED');
CREATE TYPE audit_result          AS ENUM ('SUCCESS','FAILURE','DENIED');
CREATE TYPE pix_key_type          AS ENUM ('CPF','CNPJ','EMAIL','PHONE','RANDOM');
CREATE TYPE session_revoke_reason AS ENUM ('LOGOUT','LOGOUT_ALL','ROTATED','REUSE_DETECTED',
                                           'PASSWORD_CHANGED','ADMIN_REVOKED','EXPIRED');
CREATE TYPE delivery_zone_type    AS ENUM ('RADIUS','POLYGON','POSTAL_RANGE');
CREATE TYPE delivery_status       AS ENUM ('PENDING_ASSIGNMENT','ASSIGNED','PICKED_UP',
                                           'IN_TRANSIT','DELIVERED','FAILED','RETURNED');
CREATE TYPE mfa_type              AS ENUM ('TOTP','RECOVERY_CODE');

-- =============================================================================
-- 2. TENANCY
-- =============================================================================

CREATE TABLE organizations (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    slug            citext NOT NULL,
    legal_name      text   NOT NULL,
    trade_name      text   NOT NULL,
    tax_id_encrypted bytea,                      -- CNPJ cifrado (envelope KMS)
    tax_id_hmac     bytea,                       -- busca determinística sem expor o valor
    contact_email   citext NOT NULL,
    contact_phone   text,
    status          org_status NOT NULL DEFAULT 'ACTIVE',
    feature_flags   jsonb  NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$')
);
CREATE UNIQUE INDEX organizations_slug_uk    ON organizations (slug)        WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX organizations_tax_id_uk  ON organizations (tax_id_hmac) WHERE deleted_at IS NULL AND tax_id_hmac IS NOT NULL;
CREATE INDEX organizations_status_idx        ON organizations (status)      WHERE deleted_at IS NULL;

CREATE TABLE branches (
    id               uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    slug             citext NOT NULL,
    name             text   NOT NULL,
    phone_e164       text,
    timezone         text   NOT NULL DEFAULT 'America/Sao_Paulo',
    status           branch_status NOT NULL DEFAULT 'ACTIVE',
    -- endereço da loja
    postal_code      text,
    street           text,
    street_number    text,
    complement       text,
    district         text,
    city             text,
    state_code       char(2),
    location         geography(Point, 4326),
    accepts_pickup   boolean NOT NULL DEFAULT true,
    accepts_delivery boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT branches_fulfillment_chk CHECK (accepts_pickup OR accepts_delivery)
);
-- slug único DENTRO da organização: duas franquias podem ter a unidade "centro"
CREATE UNIQUE INDEX branches_org_slug_uk ON branches (organization_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX branches_org_idx            ON branches (organization_id)       WHERE deleted_at IS NULL;
CREATE INDEX branches_location_gix       ON branches USING gist (location)   WHERE deleted_at IS NULL;

CREATE TABLE store_settings (
    branch_id                uuid PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
    organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    preparation_time_minutes integer NOT NULL DEFAULT 20 CHECK (preparation_time_minutes BETWEEN 0 AND 480),
    min_order_cents          bigint  NOT NULL DEFAULT 0  CHECK (min_order_cents >= 0),
    auto_accept_orders       boolean NOT NULL DEFAULT false,
    -- TTL da reserva de estoque enquanto o pagamento não é confirmado
    payment_hold_minutes     integer NOT NULL DEFAULT 15 CHECK (payment_hold_minutes BETWEEN 1 AND 120),
    -- métodos habilitados: subconjunto de payment_method
    enabled_payment_methods  payment_method[] NOT NULL DEFAULT
                             ARRAY['PIX','CREDIT_ON_SITE','DEBIT_ON_SITE','CASH_ON_SITE']::payment_method[],
    cancellation_window_minutes integer NOT NULL DEFAULT 5 CHECK (cancellation_window_minutes >= 0),
    currency                 char(3) NOT NULL DEFAULT 'BRL',
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT store_settings_methods_chk CHECK (cardinality(enabled_payment_methods) > 0)
);

CREATE TABLE branding_settings (
    branch_id        uuid PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    logo_storage_key text,
    cover_storage_key text,
    primary_color    char(7) CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
    secondary_color  char(7) CHECK (secondary_color ~ '^#[0-9a-fA-F]{6}$'),
    display_name     text,
    tagline          text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Chave Pix: cifrada em repouso; só os últimos 4 dígitos ficam em claro para exibição.
CREATE TABLE pix_settings (
    branch_id       uuid PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    key_type        pix_key_type NOT NULL,
    key_encrypted   bytea NOT NULL,
    key_last4       text  NOT NULL CHECK (length(key_last4) <= 4),
    key_fingerprint bytea NOT NULL,               -- HMAC: detecta troca de chave sem decifrar
    merchant_name   text  NOT NULL CHECK (length(merchant_name) BETWEEN 1 AND 25),  -- limite EMV
    merchant_city   text  NOT NULL CHECK (length(merchant_city) BETWEEN 1 AND 15),  -- limite EMV
    is_active       boolean NOT NULL DEFAULT true,
    updated_by      uuid,                          -- FK adicionada após users
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_hours (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = domingo
    opens_at        time NOT NULL,
    closes_at       time NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- fechamento após meia-noite é representado por duas faixas
    CONSTRAINT business_hours_range_chk CHECK (closes_at > opens_at),
    -- duas faixas do mesmo dia na mesma unidade não podem se sobrepor
    CONSTRAINT business_hours_no_overlap EXCLUDE USING gist (
        branch_id WITH =,
        weekday   WITH =,
        timerange(opens_at, closes_at, '[)') WITH &&
    )
);
CREATE INDEX business_hours_branch_idx ON business_hours (branch_id, weekday);

-- =============================================================================
-- 3. IDENTIDADE E ACESSO
-- =============================================================================

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    type                user_type NOT NULL,
    organization_id     uuid REFERENCES organizations(id) ON DELETE RESTRICT,
    email               citext,
    phone_e164          text,
    full_name           text NOT NULL,
    password_hash       text,                       -- Argon2id; NULL quando o login é por OTP
    password_updated_at timestamptz,
    -- incrementar invalida TODOS os access tokens: "sair de todos os dispositivos"
    token_version       integer  NOT NULL DEFAULT 1,
    email_verified_at   timestamptz,
    phone_verified_at   timestamptz,
    mfa_enabled         boolean  NOT NULL DEFAULT false,
    failed_login_count  smallint NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    last_login_at       timestamptz,
    is_active           boolean  NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    -- operador SEMPRE pertence a uma organização; cliente é global à plataforma
    CONSTRAINT users_tenant_chk CHECK (
        (type = 'STAFF'    AND organization_id IS NOT NULL) OR
        (type = 'CUSTOMER' AND organization_id IS NULL)
    ),
    CONSTRAINT users_identifier_chk CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL),
    CONSTRAINT users_phone_format_chk CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);
-- Unicidade por escopo: operador é único na organização; cliente é único na plataforma
CREATE UNIQUE INDEX users_staff_email_uk    ON users (organization_id, email)
    WHERE type = 'STAFF' AND deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX users_customer_email_uk ON users (email)
    WHERE type = 'CUSTOMER' AND deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX users_customer_phone_uk ON users (phone_e164)
    WHERE type = 'CUSTOMER' AND deleted_at IS NULL AND phone_e164 IS NOT NULL;
CREATE INDEX users_org_idx ON users (organization_id) WHERE type = 'STAFF' AND deleted_at IS NULL;

ALTER TABLE pix_settings
    ADD CONSTRAINT pix_settings_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE roles (
    id          uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    code        text NOT NULL UNIQUE,   -- SUPER_ADMIN, FRANCHISE_ADMIN, UNIT_MANAGER, OPERATOR, DELIVERY, CUSTOMER
    name        text NOT NULL,
    description text,
    -- nível hierárquico: um papel só concede papéis de nível estritamente maior (menos privilegiado)
    hierarchy_level smallint NOT NULL,
    is_system   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    id          uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    code        text NOT NULL UNIQUE,   -- formato: recurso:acao  (ex.: 'order:transition')
    resource    text NOT NULL,
    action      text NOT NULL,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT permissions_code_format_chk CHECK (code ~ '^[a-z_]+:[a-z_]+$')
);
CREATE UNIQUE INDEX permissions_resource_action_uk ON permissions (resource, action);

CREATE TABLE role_permissions (
    role_id       uuid NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, permission_id)
);

-- Concessão de papel SEMPRE com escopo: organização e, opcionalmente, unidade.
-- branch_id NULL = papel válido em toda a organização.
CREATE TABLE user_roles (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id         uuid NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles(id)        ON DELETE RESTRICT,
    organization_id uuid REFERENCES organizations(id)          ON DELETE CASCADE,
    branch_id       uuid REFERENCES branches(id)               ON DELETE CASCADE,
    granted_by      uuid REFERENCES users(id)                  ON DELETE SET NULL,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,          -- acesso administrativo temporário entre unidades
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_roles_expiry_chk CHECK (expires_at IS NULL OR expires_at > granted_at)
);
CREATE UNIQUE INDEX user_roles_unique_scope_uk
    ON user_roles (user_id, role_id, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   COALESCE(branch_id,       '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE revoked_at IS NULL;
CREATE INDEX user_roles_user_active_idx ON user_roles (user_id)
    WHERE revoked_at IS NULL;
CREATE INDEX user_roles_branch_idx      ON user_roles (branch_id)
    WHERE revoked_at IS NULL AND branch_id IS NOT NULL;
CREATE INDEX user_roles_expiring_idx    ON user_roles (expires_at)
    WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

-- Vínculo cliente↔franquia: define o que cada franquia pode ver do cliente (LGPD)
-- e o consentimento de comunicação por canal.
CREATE TABLE customer_organization_links (
    id                 uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    customer_id        uuid NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
    organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    first_order_at     timestamptz,
    last_order_at      timestamptz,
    orders_count       integer NOT NULL DEFAULT 0,
    whatsapp_opt_in    boolean NOT NULL DEFAULT false,
    whatsapp_opt_in_at timestamptz,
    marketing_opt_in   boolean NOT NULL DEFAULT false,
    opted_out_at       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (customer_id, organization_id)
);
CREATE INDEX customer_org_links_org_idx ON customer_organization_links (organization_id);

CREATE TABLE sessions (
    id                  uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id             uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  bytea NOT NULL,        -- SHA-256 do token opaco (nunca o token)
    family_id           uuid  NOT NULL,        -- todas as rotações de uma mesma sessão
    replaced_by         uuid REFERENCES sessions(id) ON DELETE SET NULL,
    device_id           text,
    device_name         text,
    user_agent          text,
    ip_address          inet,
    issued_at           timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    revoked_reason      session_revoke_reason,
    CONSTRAINT sessions_expiry_chk CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX sessions_refresh_hash_uk ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx      ON sessions (family_id);
CREATE INDEX sessions_expiry_idx      ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE mfa_credentials (
    id           uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type         mfa_type NOT NULL,
    secret_encrypted bytea NOT NULL,           -- TOTP: segredo cifrado; RECOVERY_CODE: hash
    label        text,
    confirmed_at timestamptz,
    last_used_at timestamptz,
    used_at      timestamptz,                  -- código de recuperação é de uso único
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_credentials_user_idx ON mfa_credentials (user_id, type);

CREATE TABLE login_attempts (
    id             uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    identifier     citext NOT NULL,            -- e-mail/telefone tentado (mesmo inexistente)
    user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    ip_address     inet,
    user_agent     text,
    succeeded      boolean NOT NULL,
    failure_reason text,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_identifier_idx ON login_attempts (identifier, created_at DESC);
CREATE INDEX login_attempts_ip_idx         ON login_attempts (ip_address, created_at DESC);

CREATE TABLE password_reset_tokens (
    id         uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id    uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL,
    ip_address inet,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX password_reset_tokens_hash_uk ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id) WHERE used_at IS NULL;

CREATE TABLE otp_codes (
    id          uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    identifier  citext NOT NULL,               -- telefone/e-mail destino
    code_hash   bytea  NOT NULL,
    purpose     text   NOT NULL,               -- LOGIN | PHONE_VERIFY | EMAIL_VERIFY
    attempts    smallint NOT NULL DEFAULT 0,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_identifier_idx ON otp_codes (identifier, purpose, created_at DESC);

CREATE TABLE device_tokens (
    id          uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform    text NOT NULL CHECK (platform IN ('IOS','ANDROID','WEB')),
    token       text NOT NULL,
    device_id   text,
    is_active   boolean NOT NULL DEFAULT true,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX device_tokens_token_uk ON device_tokens (token) WHERE is_active;
CREATE INDEX device_tokens_user_idx        ON device_tokens (user_id) WHERE is_active;

-- =============================================================================
-- 4. CATÁLOGO
-- =============================================================================

CREATE TABLE categories (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id       uuid NOT NULL REFERENCES branches(id)      ON DELETE CASCADE,
    name            text NOT NULL,
    description     text,
    position        smallint NOT NULL DEFAULT 0,
    is_active       boolean  NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
CREATE UNIQUE INDEX categories_branch_name_uk ON categories (branch_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX categories_branch_active_idx     ON categories (branch_id, position)    WHERE deleted_at IS NULL AND is_active;

CREATE TABLE products (
    id                       uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id                uuid NOT NULL REFERENCES branches(id)      ON DELETE CASCADE,
    -- FK definida abaixo como composta (id, branch_id): garante que a categoria
    -- pertence à MESMA unidade do produto — integridade de tenant no banco
    category_id              uuid,
    name                     text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    description              text CHECK (description IS NULL OR length(description) <= 2000),
    sku                      text,
    price_cents              bigint  NOT NULL CHECK (price_cents >= 0),
    currency                 char(3) NOT NULL DEFAULT 'BRL',
    is_active                boolean NOT NULL DEFAULT true,
    preparation_time_minutes integer CHECK (preparation_time_minutes IS NULL OR preparation_time_minutes BETWEEN 0 AND 480),
    position                 smallint NOT NULL DEFAULT 0,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    deleted_at               timestamptz
);
CREATE UNIQUE INDEX products_branch_sku_uk    ON products (branch_id, sku)
    WHERE deleted_at IS NULL AND sku IS NOT NULL;
CREATE INDEX products_menu_idx                ON products (branch_id, category_id, position)
    WHERE deleted_at IS NULL AND is_active;
CREATE INDEX products_org_idx                 ON products (organization_id) WHERE deleted_at IS NULL;
-- Categoria e produto precisam ser da MESMA unidade: a FK composta torna impossível
-- referenciar categoria de outra unidade, mesmo com bug de aplicação.
-- `SET NULL (category_id)` (PostgreSQL 15+) anula apenas a categoria — anular
-- branch_id violaria NOT NULL e quebraria o DELETE.
CREATE UNIQUE INDEX categories_id_branch_uk ON categories (id, branch_id);
ALTER TABLE products
    ADD CONSTRAINT products_category_same_branch_fk
    FOREIGN KEY (category_id, branch_id) REFERENCES categories (id, branch_id)
    ON DELETE SET NULL (category_id);

CREATE TABLE product_images (
    id           uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    storage_key  text NOT NULL,      -- UUID gerado pelo servidor; nome do usuário NUNCA é usado
    content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
    byte_size    integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5 * 1024 * 1024),
    width        integer,
    height       integer,
    blurhash     text,
    alt_text     text,
    position     smallint NOT NULL DEFAULT 0,
    is_primary   boolean  NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);
CREATE UNIQUE INDEX product_images_storage_key_uk ON product_images (storage_key);
CREATE UNIQUE INDEX product_images_primary_uk     ON product_images (product_id)
    WHERE is_primary AND deleted_at IS NULL;      -- no máximo uma imagem principal
CREATE INDEX product_images_product_idx           ON product_images (product_id, position) WHERE deleted_at IS NULL;

CREATE TABLE modifier_groups (
    id           uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name         text NOT NULL,             -- "Ponto da carne", "Adicionais"
    min_select   smallint NOT NULL DEFAULT 0 CHECK (min_select >= 0),
    max_select   smallint NOT NULL DEFAULT 1 CHECK (max_select >= 1),
    is_required  boolean  NOT NULL DEFAULT false,
    position     smallint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz,
    CONSTRAINT modifier_groups_select_chk CHECK (max_select >= min_select)
);

CREATE TABLE modifier_options (
    id                uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    modifier_group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name              text NOT NULL,
    price_delta_cents bigint NOT NULL DEFAULT 0,   -- pode ser negativo (desconto por remoção)
    is_available      boolean NOT NULL DEFAULT true,
    position          smallint NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz
);
CREATE INDEX modifier_options_group_idx ON modifier_options (modifier_group_id, position) WHERE deleted_at IS NULL;

CREATE TABLE product_modifier_groups (
    product_id        uuid NOT NULL REFERENCES products(id)        ON DELETE CASCADE,
    modifier_group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    position          smallint NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, modifier_group_id)
);

-- =============================================================================
-- 5. ESTOQUE VIRTUAL
-- =============================================================================

CREATE TABLE virtual_inventory (
    id                    uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id             uuid NOT NULL REFERENCES branches(id)      ON DELETE CASCADE,
    product_id            uuid NOT NULL REFERENCES products(id)      ON DELETE CASCADE,
    mode                  availability_mode NOT NULL DEFAULT 'INFINITE',
    on_hand_qty           integer NOT NULL DEFAULT 0 CHECK (on_hand_qty  >= 0),
    reserved_qty          integer NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
    -- "MARCAR COMO ESGOTADO": independente da quantidade
    is_manually_sold_out  boolean NOT NULL DEFAULT false,
    sold_out_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    sold_out_at           timestamptz,
    reactivated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    reactivated_at        timestamptz,
    low_stock_threshold   integer CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    -- INVARIANTE CENTRAL DO SISTEMA: reservado nunca ultrapassa o disponível físico.
    -- Nenhum bug de aplicação consegue causar overselling sem violar esta constraint.
    CONSTRAINT virtual_inventory_reserved_chk CHECK (reserved_qty <= on_hand_qty),
    CONSTRAINT virtual_inventory_soldout_chk  CHECK (
        (is_manually_sold_out = false) OR (sold_out_at IS NOT NULL)
    )
);
CREATE UNIQUE INDEX virtual_inventory_branch_product_uk ON virtual_inventory (branch_id, product_id);
CREATE UNIQUE INDEX virtual_inventory_product_uk        ON virtual_inventory (product_id);
CREATE INDEX virtual_inventory_low_stock_idx            ON virtual_inventory (branch_id)
    WHERE mode = 'LIMITED' AND low_stock_threshold IS NOT NULL;

-- Razão append-only: toda mudança de estoque escreve uma linha com o estado RESULTANTE,
-- permitindo reconstruir o saldo por replay e detectar divergência.
CREATE TABLE inventory_movements (
    id                   uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id            uuid NOT NULL REFERENCES branches(id)      ON DELETE RESTRICT,
    virtual_inventory_id uuid NOT NULL REFERENCES virtual_inventory(id) ON DELETE RESTRICT,
    product_id           uuid NOT NULL REFERENCES products(id)      ON DELETE RESTRICT,
    type                 movement_type NOT NULL,
    quantity_delta       integer NOT NULL,
    on_hand_after        integer NOT NULL CHECK (on_hand_after  >= 0),
    reserved_after       integer NOT NULL CHECK (reserved_after >= 0),
    order_id             uuid,                      -- FK adicionada após orders
    actor_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_type           actor_type NOT NULL DEFAULT 'SYSTEM',
    reason               text,
    created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_inv_idx   ON inventory_movements (virtual_inventory_id, created_at DESC);
CREATE INDEX inventory_movements_order_idx ON inventory_movements (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX inventory_movements_branch_idx ON inventory_movements (branch_id, created_at DESC);

CREATE TRIGGER inventory_movements_immutable
    BEFORE UPDATE OR DELETE ON inventory_movements
    FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- Reservas ativas: o job de expiração precisa saber exatamente o que liberar,
-- de forma idempotente. Derivar isso do razão exigiria varredura agregada.
CREATE TABLE inventory_reservations (
    id                   uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id            uuid NOT NULL REFERENCES branches(id)      ON DELETE CASCADE,
    order_id             uuid NOT NULL,             -- FK adicionada após orders
    virtual_inventory_id uuid NOT NULL REFERENCES virtual_inventory(id) ON DELETE RESTRICT,
    quantity             integer NOT NULL CHECK (quantity > 0),
    status               reservation_status NOT NULL DEFAULT 'ACTIVE',
    expires_at           timestamptz NOT NULL,
    resolved_at          timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_reservations_expiring_idx ON inventory_reservations (expires_at)
    WHERE status = 'ACTIVE';
CREATE INDEX inventory_reservations_order_idx    ON inventory_reservations (order_id);
CREATE UNIQUE INDEX inventory_reservations_order_inv_uk
    ON inventory_reservations (order_id, virtual_inventory_id) WHERE status = 'ACTIVE';

-- =============================================================================
-- 6. ENTREGA (endereços e zonas — antes de orders, que os referencia)
-- =============================================================================

CREATE TABLE delivery_addresses (
    id            uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    customer_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label         text,                       -- "Casa", "Trabalho"
    postal_code   text NOT NULL,
    street        text NOT NULL,
    street_number text NOT NULL,
    complement    text,
    district      text NOT NULL,
    city          text NOT NULL,
    state_code    char(2) NOT NULL,
    reference     text,
    location      geography(Point, 4326),
    is_default    boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);
CREATE INDEX delivery_addresses_customer_idx ON delivery_addresses (customer_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX delivery_addresses_default_uk ON delivery_addresses (customer_id)
    WHERE is_default AND deleted_at IS NULL;

CREATE TABLE delivery_zones (
    id               uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id        uuid NOT NULL REFERENCES branches(id)      ON DELETE CASCADE,
    name             text NOT NULL,
    type             delivery_zone_type NOT NULL,
    radius_meters    integer  CHECK (radius_meters IS NULL OR radius_meters > 0),
    area             geography(Polygon, 4326),
    postal_code_from text,
    postal_code_to   text,
    fee_cents        bigint  NOT NULL CHECK (fee_cents >= 0),
    min_order_cents  bigint  NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
    eta_minutes      integer NOT NULL DEFAULT 40 CHECK (eta_minutes > 0),
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT delivery_zones_shape_chk CHECK (
        (type = 'RADIUS'       AND radius_meters IS NOT NULL) OR
        (type = 'POLYGON'      AND area IS NOT NULL) OR
        (type = 'POSTAL_RANGE' AND postal_code_from IS NOT NULL AND postal_code_to IS NOT NULL)
    )
);
CREATE INDEX delivery_zones_branch_idx ON delivery_zones (branch_id) WHERE is_active AND deleted_at IS NULL;
CREATE INDEX delivery_zones_area_gix   ON delivery_zones USING gist (area) WHERE area IS NOT NULL;

-- =============================================================================
-- 7. PEDIDOS
-- =============================================================================

-- Numeração amigável atômica e por unidade (#1042), com reinício diário opcional.
CREATE TABLE order_number_counters (
    branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    business_date date NOT NULL,
    last_number   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, business_date)
);

CREATE TABLE orders (
    id                        uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id                 uuid NOT NULL REFERENCES branches(id)      ON DELETE RESTRICT,
    customer_id               uuid NOT NULL REFERENCES users(id)         ON DELETE RESTRICT,
    order_number              text NOT NULL,          -- amigável, único por unidade
    status                    order_status   NOT NULL DEFAULT 'PENDING',
    fulfillment               fulfillment_type NOT NULL,
    payment_method            payment_method NOT NULL,
    -- valores: SEMPRE calculados no servidor; o cliente nunca envia preço
    currency                  char(3) NOT NULL DEFAULT 'BRL',
    subtotal_cents            bigint  NOT NULL CHECK (subtotal_cents     >= 0),
    delivery_fee_cents        bigint  NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
    discount_cents            bigint  NOT NULL DEFAULT 0 CHECK (discount_cents     >= 0),
    total_cents               bigint  NOT NULL CHECK (total_cents        >= 0),
    -- snapshot: o pedido não depende do endereço continuar existindo
    delivery_address_id       uuid REFERENCES delivery_addresses(id) ON DELETE SET NULL,
    delivery_address_snapshot jsonb,
    delivery_zone_id          uuid REFERENCES delivery_zones(id) ON DELETE SET NULL,
    customer_notes            text CHECK (customer_notes IS NULL OR length(customer_notes) <= 500),
    internal_notes            text,
    estimated_ready_at        timestamptz,
    reservation_expires_at    timestamptz,     -- espelha o TTL da reserva de estoque
    placed_at                 timestamptz NOT NULL DEFAULT now(),
    confirmed_at              timestamptz,
    ready_at                  timestamptz,
    completed_at              timestamptz,
    cancelled_at              timestamptz,
    cancellation_reason       text,
    client_ip                 inet,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    -- a aritmética do pedido é invariante de banco
    CONSTRAINT orders_total_chk CHECK (
        total_cents = subtotal_cents + delivery_fee_cents - discount_cents
    ),
    CONSTRAINT orders_discount_chk CHECK (discount_cents <= subtotal_cents + delivery_fee_cents),
    -- entrega exige endereço; retirada não pode cobrar taxa de entrega
    CONSTRAINT orders_delivery_chk CHECK (
        (fulfillment = 'DELIVERY' AND delivery_address_snapshot IS NOT NULL) OR
        (fulfillment = 'PICKUP'   AND delivery_fee_cents = 0)
    )
);
CREATE UNIQUE INDEX orders_branch_number_uk ON orders (branch_id, order_number);
-- índice PARCIAL: a fila de pedidos abertos é dezenas de linhas dentro de milhões
CREATE INDEX orders_active_queue_idx ON orders (branch_id, status, placed_at DESC)
    WHERE status NOT IN ('DELIVERED','PICKED_UP','CANCELLED','REJECTED','EXPIRED');
CREATE INDEX orders_customer_idx     ON orders (customer_id, placed_at DESC);
CREATE INDEX orders_org_placed_idx   ON orders (organization_id, placed_at DESC);
CREATE INDEX orders_expiring_idx     ON orders (reservation_expires_at)
    WHERE status = 'AWAITING_PAYMENT';

ALTER TABLE inventory_movements
    ADD CONSTRAINT inventory_movements_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE inventory_reservations
    ADD CONSTRAINT inventory_reservations_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;

CREATE TABLE order_items (
    id                        uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    order_id                  uuid NOT NULL REFERENCES orders(id)   ON DELETE CASCADE,
    product_id                uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    -- SNAPSHOT: se o produto mudar de nome/preço, o pedido antigo continua verdadeiro
    product_name_snapshot     text   NOT NULL,
    product_sku_snapshot      text,
    unit_price_cents_snapshot bigint NOT NULL CHECK (unit_price_cents_snapshot >= 0),
    quantity                  integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
    options_total_cents       bigint  NOT NULL DEFAULT 0,
    line_total_cents          bigint  NOT NULL CHECK (line_total_cents >= 0),
    notes                     text CHECK (notes IS NULL OR length(notes) <= 200),
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT order_items_line_total_chk CHECK (
        line_total_cents = (unit_price_cents_snapshot + options_total_cents) * quantity
    )
);
CREATE INDEX order_items_order_idx   ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id);

CREATE TABLE order_item_options (
    id                        uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    order_item_id             uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    modifier_option_id        uuid REFERENCES modifier_options(id) ON DELETE SET NULL,
    option_name_snapshot      text   NOT NULL,
    group_name_snapshot       text   NOT NULL,
    price_delta_cents_snapshot bigint NOT NULL,
    quantity                  smallint NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_item_options_item_idx ON order_item_options (order_item_id);

-- Histórico de status IMUTÁVEL (requisito de auditoria)
CREATE TABLE order_status_history (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    from_status     order_status,               -- NULL na criação
    to_status       order_status NOT NULL,
    actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_type      actor_type NOT NULL,
    reason          text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address      inet,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT order_status_history_transition_chk CHECK (from_status IS DISTINCT FROM to_status)
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, created_at);

CREATE TRIGGER order_status_history_immutable
    BEFORE UPDATE OR DELETE ON order_status_history
    FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- =============================================================================
-- 8. PAGAMENTOS
-- =============================================================================

CREATE TABLE payments (
    id                  uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id           uuid NOT NULL REFERENCES branches(id)      ON DELETE RESTRICT,
    order_id            uuid NOT NULL REFERENCES orders(id)        ON DELETE RESTRICT,
    method              payment_method NOT NULL,
    status              payment_status NOT NULL DEFAULT 'PENDING',
    amount_cents        bigint  NOT NULL CHECK (amount_cents > 0),
    currency            char(3) NOT NULL DEFAULT 'BRL',
    -- agnóstico de provedor: hoje MANUAL_PIX / ON_SITE, amanhã um PSP
    provider            text NOT NULL,
    provider_payment_id text,
    -- Pix
    pix_brcode          text,        -- "Copia e Cola" EMV gerado pelo servidor
    pix_txid            text,
    pix_key_last4       text,
    -- confirmação (manual hoje; por webhook quando houver PSP)
    confirmed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at        timestamptz,
    confirmed_ip        inet,
    confirmation_note   text,
    failure_reason      text,
    refunded_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payments_confirmation_chk CHECK (
        (status <> 'CONFIRMED') OR (confirmed_at IS NOT NULL)
    )
);
CREATE INDEX payments_order_idx    ON payments (order_id);
CREATE INDEX payments_branch_idx   ON payments (branch_id, status, created_at DESC);
CREATE UNIQUE INDEX payments_provider_id_uk ON payments (provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payments_pix_txid_uk    ON payments (pix_txid) WHERE pix_txid IS NOT NULL;
-- um único pagamento ativo por pedido
CREATE UNIQUE INDEX payments_order_active_uk ON payments (order_id)
    WHERE status IN ('PENDING','AWAITING_CONFIRMATION','CONFIRMED');

-- Razão bruto do que o provedor enviou (webhooks) — append-only, base de conciliação
CREATE TABLE payment_events (
    id           uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    payment_id   uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    event_type   text NOT NULL,
    provider     text NOT NULL,
    provider_event_id text,
    payload      jsonb NOT NULL,
    signature_valid boolean,
    received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_events_provider_event_uk ON payment_events (provider, provider_event_id)
    WHERE provider_event_id IS NOT NULL;      -- idempotência de webhook / anti-replay
CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, received_at DESC);

CREATE TRIGGER payment_events_immutable
    BEFORE UPDATE OR DELETE ON payment_events
    FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- =============================================================================
-- 9. ENTREGAS (execução)
-- =============================================================================

CREATE TABLE deliveries (
    id               uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id        uuid NOT NULL REFERENCES branches(id)      ON DELETE RESTRICT,
    order_id         uuid NOT NULL REFERENCES orders(id)        ON DELETE RESTRICT,
    courier_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    status           delivery_status NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
    fee_cents        bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
    assigned_at      timestamptz,
    dispatched_at    timestamptz,
    delivered_at     timestamptz,
    failure_reason   text,
    proof_type       text CHECK (proof_type IS NULL OR proof_type IN ('PHOTO','CODE','SIGNATURE')),
    proof_storage_key text,
    last_location    geography(Point, 4326),
    last_location_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deliveries_order_uk   ON deliveries (order_id);
CREATE INDEX deliveries_courier_idx       ON deliveries (courier_user_id, status);
CREATE INDEX deliveries_branch_active_idx ON deliveries (branch_id, status)
    WHERE status NOT IN ('DELIVERED','FAILED','RETURNED');

-- =============================================================================
-- 10. PLATAFORMA: AUDITORIA, OUTBOX, NOTIFICAÇÕES, INTEGRAÇÕES
-- =============================================================================

-- Trilha imutável com encadeamento de hash: adulterar um registro quebra a cadeia
-- de forma detectável, inclusive por quem tem acesso direto ao banco.
CREATE TABLE audit_logs (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id       uuid REFERENCES branches(id)      ON DELETE RESTRICT,
    actor_user_id   uuid REFERENCES users(id)         ON DELETE SET NULL,
    actor_type      actor_type NOT NULL DEFAULT 'STAFF',
    action          text NOT NULL,          -- 'order.status_changed', 'pix_settings.updated', ...
    resource_type   text NOT NULL,
    resource_id     uuid,
    result          audit_result NOT NULL DEFAULT 'SUCCESS',
    ip_address      inet,
    user_agent      text,
    request_id      text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- redigido: sem senha/token/chave/CPF
    prev_hash       bytea,
    record_hash     bytea NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx  ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx     ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx  ON audit_logs (organization_id, resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_action_idx    ON audit_logs (action, created_at DESC);

CREATE TRIGGER audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- Outbox transacional: o evento comita junto com a mudança de negócio.
CREATE TABLE outbox_events (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid,
    branch_id       uuid,
    aggregate_type  text NOT NULL,          -- 'order', 'payment', 'inventory'
    aggregate_id    uuid NOT NULL,
    event_type      text NOT NULL,          -- 'order.status_changed'
    payload         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    attempts        smallint NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (next_attempt_at)
    WHERE published_at IS NULL;
CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_type, aggregate_id);

CREATE TABLE notifications (
    id                  uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id           uuid REFERENCES branches(id) ON DELETE RESTRICT,
    order_id            uuid REFERENCES orders(id)   ON DELETE RESTRICT,
    recipient_user_id   uuid REFERENCES users(id)    ON DELETE SET NULL,
    recipient_address   text,                 -- telefone/e-mail/device token (redigido em log)
    channel             notification_channel NOT NULL,
    template_name       text,
    template_variables  jsonb NOT NULL DEFAULT '{}'::jsonb,
    status              notification_status NOT NULL DEFAULT 'QUEUED',
    provider            text,
    provider_message_id text,
    attempts            smallint NOT NULL DEFAULT 0,
    failure_reason      text,
    sent_at             timestamptz,
    delivered_at        timestamptz,
    read_at             timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_order_idx    ON notifications (order_id);
CREATE INDEX notifications_status_idx   ON notifications (status, created_at DESC) WHERE status IN ('QUEUED','FAILED');
CREATE UNIQUE INDEX notifications_provider_msg_uk ON notifications (provider, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- O token de acesso NÃO fica aqui: apenas uma referência ao secret manager.
CREATE TABLE whatsapp_integrations (
    id                      uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id               uuid REFERENCES branches(id) ON DELETE CASCADE,
    provider                text NOT NULL DEFAULT 'META_CLOUD_API',
    waba_id                 text,
    phone_number_id         text NOT NULL,
    display_phone_number    text,
    access_token_secret_ref text NOT NULL,          -- ex.: ARN do Secrets Manager
    webhook_verify_token_ref text,
    app_secret_ref          text,
    template_map            jsonb NOT NULL DEFAULT '{}'::jsonb,
    quality_rating          text,
    is_active               boolean NOT NULL DEFAULT true,
    last_error              text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX whatsapp_integrations_phone_uk ON whatsapp_integrations (phone_number_id) WHERE is_active;
CREATE INDEX whatsapp_integrations_org_idx ON whatsapp_integrations (organization_id) WHERE is_active;

-- Idempotência de POST: mesma chave com corpo diferente é conflito, não repetição.
CREATE TABLE idempotency_keys (
    key             text PRIMARY KEY,
    user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
    endpoint        text  NOT NULL,
    request_hash    bytea NOT NULL,
    response_status smallint,
    response_body   jsonb,
    resource_id     uuid,
    locked_at       timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE media_assets (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id       uuid REFERENCES branches(id)      ON DELETE CASCADE,
    storage_key     text NOT NULL UNIQUE,     -- UUID; jamais o nome enviado pelo usuário
    content_type    text NOT NULL,
    byte_size       integer NOT NULL CHECK (byte_size > 0),
    checksum_sha256 bytea NOT NULL,
    uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    scan_status     text NOT NULL DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING','CLEAN','INFECTED','ERROR')),
    is_confirmed    boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
CREATE INDEX media_assets_orphan_idx ON media_assets (created_at) WHERE is_confirmed = false;

-- =============================================================================
-- 11. TRIGGERS DE updated_at
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'organizations','branches','store_settings','branding_settings','pix_settings',
        'business_hours','users','roles','user_roles','customer_organization_links',
        'categories','products','modifier_groups','modifier_options','virtual_inventory',
        'inventory_reservations','delivery_addresses','delivery_zones','orders','payments',
        'deliveries','notifications','whatsapp_integrations'
    ]
    LOOP
        EXECUTE format(
            'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t, t);
    END LOOP;
END $$;

-- =============================================================================
-- 12. SEED DE PAPÉIS E PERMISSÕES
-- =============================================================================

INSERT INTO roles (code, name, hierarchy_level, description) VALUES
    ('SUPER_ADMIN',     'Administrador da plataforma', 0, 'Operação da plataforma; acesso auditado a todas as organizações'),
    ('FRANCHISE_ADMIN', 'Administrador da franquia',   1, 'Administra a organização e todas as suas unidades'),
    ('UNIT_MANAGER',    'Gerente de unidade',          2, 'Administra uma unidade: catálogo, preços, operadores, configurações'),
    ('OPERATOR',        'Operador',                    3, 'Opera pedidos e disponibilidade da unidade'),
    ('DELIVERY',        'Entregador',                  4, 'Vê e atualiza apenas as entregas atribuídas a ele'),
    ('CUSTOMER',        'Cliente',                     5, 'Compra e acompanha os próprios pedidos');

INSERT INTO permissions (code, resource, action, description) VALUES
    ('organization:read','organization','read','Ver dados da organização'),
    ('organization:update','organization','update','Alterar dados da organização'),
    ('branch:create','branch','create','Criar unidade'),
    ('branch:read','branch','read','Ver unidade'),
    ('branch:update','branch','update','Alterar unidade'),
    ('branch:archive','branch','archive','Arquivar unidade'),
    ('user:create','user','create','Criar usuário'),
    ('user:read','user','read','Ver usuários'),
    ('user:update','user','update','Alterar usuário'),
    ('user:deactivate','user','deactivate','Desativar usuário'),
    ('role:assign','role','assign','Conceder papéis'),
    ('role:revoke','role','revoke','Revogar papéis'),
    ('product:create','product','create','Criar produto'),
    ('product:read','product','read','Ver produtos'),
    ('product:update','product','update','Alterar produto'),
    ('product:delete','product','delete','Excluir produto'),
    ('price:update','price','update','Alterar preço'),
    ('category:manage','category','manage','Gerenciar categorias'),
    ('inventory:read','inventory','read','Ver estoque virtual'),
    ('inventory:adjust','inventory','adjust','Ajustar quantidade em estoque'),
    ('inventory:mark_sold_out','inventory','mark_sold_out','Marcar como esgotado / reativar'),
    ('order:read','order','read','Ver pedidos da unidade'),
    ('order:read_own','order','read_own','Ver os próprios pedidos'),
    ('order:create','order','create','Criar pedido'),
    ('order:transition','order','transition','Avançar status do pedido'),
    ('order:cancel','order','cancel','Cancelar pedido'),
    ('order:refund','order','refund','Estornar pedido'),
    ('payment:read','payment','read','Ver pagamentos'),
    ('payment:confirm','payment','confirm','Confirmar pagamento manualmente'),
    ('pix_settings:read','pix_settings','read','Ver configuração de Pix'),
    ('pix_settings:update','pix_settings','update','Alterar chave Pix'),
    ('delivery:read','delivery','read','Ver entregas'),
    ('delivery:assign','delivery','assign','Atribuir entregador'),
    ('delivery:update_own','delivery','update_own','Atualizar as próprias entregas'),
    ('settings:read','settings','read','Ver configurações'),
    ('settings:update','settings','update','Alterar configurações'),
    ('branding:update','branding','update','Alterar identidade visual'),
    ('audit:read','audit','read','Ler trilha de auditoria'),
    ('report:read','report','read','Ver relatórios'),
    ('whatsapp:configure','whatsapp','configure','Configurar integração WhatsApp');

-- A matriz completa papel × permissão está em docs/06-modelo-de-permissoes.md.
-- Exemplo (OPERATOR): conjunto mínimo para operar a unidade sem tocar em preço,
-- configuração, usuários ou chave Pix.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code = 'OPERATOR'
  AND p.code IN ('product:read','inventory:read','inventory:mark_sold_out',
                 'order:read','order:transition','payment:read','delivery:read',
                 'branch:read','settings:read');
