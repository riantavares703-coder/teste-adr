-- =============================================================================
--  SCHEMA IMPLEMENTADO — baseline
--
--  Deriva de docs/sql/schema.sql (arquitetura aprovada no Prompt 01), com três
--  desvios exigidos pelo Prompt 02 e um imposto pelo ambiente. Cada um está
--  justificado em docs/ARQUITETURA-DELTA.md:
--
--   D1. order_status NÃO contém AWAITING_PAYMENT  (item 7: máquinas separadas)
--   D2. products ganha is_featured / notes / allows_customer_notes  (item 1)
--   D3. product_images ganha as variantes geradas (thumb/medium)    (item 2)
--   D4. sem PostGIS: latitude/longitude em double precision         (ambiente)
--
--  Este arquivo é a AUTORIDADE do schema em produção.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timerange') THEN
        CREATE TYPE timerange AS RANGE (subtype = time);
    END IF;
END $$;

-- UUIDv7: ordenável no tempo (localidade de índice) e não enumerável.
CREATE OR REPLACE FUNCTION app.uuid_generate_v7()
RETURNS uuid LANGUAGE sql VOLATILE AS $$
    SELECT encode(
        set_bit(set_bit(
            overlay(uuid_send(gen_random_uuid())
                    PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                    FROM 1 FOR 6),
            52, 1), 53, 1),
        'hex')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION app.forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Tabela % é append-only: % não é permitido', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END; $$;

-- =============================================================================
-- TIPOS
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

-- D1: sem AWAITING_PAYMENT. O estado de pagamento vive EXCLUSIVAMENTE em
-- payments.status. "Aguardando pagamento" é derivado na apresentação.
CREATE TYPE order_status          AS ENUM ('PENDING','CONFIRMED','PREPARING','READY',
                                           'AWAITING_PICKUP','OUT_FOR_DELIVERY',
                                           'PICKED_UP','DELIVERED',
                                           'CANCELLED','REJECTED','EXPIRED');

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
CREATE TYPE delivery_zone_type    AS ENUM ('RADIUS','POSTAL_RANGE');
CREATE TYPE delivery_status       AS ENUM ('PENDING_ASSIGNMENT','ASSIGNED','PICKED_UP',
                                           'IN_TRANSIT','DELIVERED','FAILED','RETURNED');
CREATE TYPE mfa_type              AS ENUM ('TOTP','RECOVERY_CODE');

-- =============================================================================
-- TENANCY
-- =============================================================================

CREATE TABLE organizations (
    id               uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    slug             citext NOT NULL,
    legal_name       text NOT NULL,
    trade_name       text NOT NULL,
    tax_id_encrypted bytea,
    tax_id_hmac      bytea,
    contact_email    citext NOT NULL,
    contact_phone    text,
    status           org_status NOT NULL DEFAULT 'ACTIVE',
    feature_flags    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$')
);
CREATE UNIQUE INDEX organizations_slug_uk ON organizations (slug) WHERE deleted_at IS NULL;

CREATE TABLE branches (
    id               uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    slug             citext NOT NULL,
    name             text NOT NULL,
    phone_e164       text,
    timezone         text NOT NULL DEFAULT 'America/Sao_Paulo',
    status           branch_status NOT NULL DEFAULT 'ACTIVE',
    postal_code      text,
    street           text,
    street_number    text,
    complement       text,
    district         text,
    city             text,
    state_code       char(2),
    latitude         double precision,   -- D4: sem PostGIS
    longitude        double precision,
    accepts_pickup   boolean NOT NULL DEFAULT true,
    accepts_delivery boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT branches_fulfillment_chk CHECK (accepts_pickup OR accepts_delivery),
    CONSTRAINT branches_latlng_chk CHECK (
        (latitude IS NULL AND longitude IS NULL) OR
        (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
    )
);
CREATE UNIQUE INDEX branches_org_slug_uk ON branches (organization_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX branches_org_idx ON branches (organization_id) WHERE deleted_at IS NULL;

CREATE TABLE store_settings (
    branch_id                   uuid PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
    organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    preparation_time_minutes    integer NOT NULL DEFAULT 20 CHECK (preparation_time_minutes BETWEEN 0 AND 480),
    min_order_cents             bigint NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
    auto_accept_orders          boolean NOT NULL DEFAULT false,
    payment_hold_minutes        integer NOT NULL DEFAULT 15 CHECK (payment_hold_minutes BETWEEN 1 AND 120),
    enabled_payment_methods     payment_method[] NOT NULL DEFAULT
                                ARRAY['PIX','CREDIT_ON_SITE','DEBIT_ON_SITE','CASH_ON_SITE']::payment_method[],
    cancellation_window_minutes integer NOT NULL DEFAULT 5 CHECK (cancellation_window_minutes >= 0),
    currency                    char(3) NOT NULL DEFAULT 'BRL',
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT store_settings_methods_chk CHECK (cardinality(enabled_payment_methods) > 0)
);

CREATE TABLE branding_settings (
    branch_id         uuid PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
    organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    logo_storage_key  text,
    cover_storage_key text,
    primary_color     char(7) CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
    secondary_color   char(7) CHECK (secondary_color ~ '^#[0-9a-fA-F]{6}$'),
    display_name      text,
    tagline           text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pix_settings (
    branch_id       uuid PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    key_type        pix_key_type NOT NULL,
    key_encrypted   bytea NOT NULL,
    key_last4       text NOT NULL CHECK (length(key_last4) <= 4),
    key_fingerprint bytea NOT NULL,
    merchant_name   text NOT NULL CHECK (length(merchant_name) BETWEEN 1 AND 25),
    merchant_city   text NOT NULL CHECK (length(merchant_city) BETWEEN 1 AND 15),
    is_active       boolean NOT NULL DEFAULT true,
    updated_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_hours (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    opens_at        time NOT NULL,
    closes_at       time NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT business_hours_range_chk CHECK (closes_at > opens_at),
    CONSTRAINT business_hours_no_overlap EXCLUDE USING gist (
        branch_id WITH =, weekday WITH =, timerange(opens_at, closes_at, '[)') WITH &&
    )
);
CREATE INDEX business_hours_branch_idx ON business_hours (branch_id, weekday);

-- =============================================================================
-- IDENTIDADE E ACESSO
-- =============================================================================

CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    type                user_type NOT NULL,
    organization_id     uuid REFERENCES organizations(id) ON DELETE RESTRICT,
    email               citext,
    phone_e164          text,
    full_name           text NOT NULL,
    password_hash       text,
    password_updated_at timestamptz,
    token_version       integer NOT NULL DEFAULT 1,
    email_verified_at   timestamptz,
    phone_verified_at   timestamptz,
    mfa_enabled         boolean NOT NULL DEFAULT false,
    failed_login_count  smallint NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    last_login_at       timestamptz,
    is_active           boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    CONSTRAINT users_tenant_chk CHECK (
        (type = 'STAFF' AND organization_id IS NOT NULL) OR
        (type = 'CUSTOMER' AND organization_id IS NULL)
    ),
    CONSTRAINT users_identifier_chk CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL),
    CONSTRAINT users_phone_format_chk CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE UNIQUE INDEX users_staff_email_uk ON users (organization_id, email)
    WHERE type = 'STAFF' AND deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX users_customer_email_uk ON users (email)
    WHERE type = 'CUSTOMER' AND deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX users_customer_phone_uk ON users (phone_e164)
    WHERE type = 'CUSTOMER' AND deleted_at IS NULL AND phone_e164 IS NOT NULL;
CREATE INDEX users_org_idx ON users (organization_id) WHERE type = 'STAFF' AND deleted_at IS NULL;

ALTER TABLE pix_settings
    ADD CONSTRAINT pix_settings_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE roles (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    code            text NOT NULL UNIQUE,
    name            text NOT NULL,
    description     text,
    hierarchy_level smallint NOT NULL,
    is_system       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    id          uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    code        text NOT NULL UNIQUE,
    resource    text NOT NULL,
    action      text NOT NULL,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT permissions_code_format_chk CHECK (code ~ '^[a-z_]+:[a-z_]+$')
);
CREATE UNIQUE INDEX permissions_resource_action_uk ON permissions (resource, action);

CREATE TABLE role_permissions (
    role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id       uuid REFERENCES branches(id) ON DELETE CASCADE,
    granted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_roles_expiry_chk CHECK (expires_at IS NULL OR expires_at > granted_at)
);
CREATE UNIQUE INDEX user_roles_unique_scope_uk ON user_roles (
    user_id, role_id,
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE revoked_at IS NULL;
CREATE INDEX user_roles_user_active_idx ON user_roles (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_roles_branch_idx ON user_roles (branch_id) WHERE revoked_at IS NULL AND branch_id IS NOT NULL;

CREATE TABLE customer_organization_links (
    id                 uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    customer_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    id                 uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash bytea NOT NULL,
    family_id          uuid NOT NULL,
    replaced_by        uuid REFERENCES sessions(id) ON DELETE SET NULL,
    device_id          text,
    device_name        text,
    user_agent         text,
    ip_address         inet,
    issued_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at       timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz,
    revoked_reason     session_revoke_reason,
    CONSTRAINT sessions_expiry_chk CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX sessions_refresh_hash_uk ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE mfa_credentials (
    id               uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type             mfa_type NOT NULL,
    secret_encrypted bytea NOT NULL,
    label            text,
    confirmed_at     timestamptz,
    last_used_at     timestamptz,
    used_at          timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_credentials_user_idx ON mfa_credentials (user_id, type);

CREATE TABLE login_attempts (
    id             uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    identifier     citext NOT NULL,
    user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    ip_address     inet,
    user_agent     text,
    succeeded      boolean NOT NULL,
    failure_reason text,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_identifier_idx ON login_attempts (identifier, created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip_address, created_at DESC);

CREATE TABLE otp_codes (
    id          uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    identifier  citext NOT NULL,
    code_hash   bytea NOT NULL,
    purpose     text NOT NULL,
    attempts    smallint NOT NULL DEFAULT 0,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_identifier_idx ON otp_codes (identifier, purpose, created_at DESC);

CREATE TABLE device_tokens (
    id           uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform     text NOT NULL CHECK (platform IN ('IOS','ANDROID','WEB')),
    token        text NOT NULL,
    device_id    text,
    is_active    boolean NOT NULL DEFAULT true,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX device_tokens_token_uk ON device_tokens (token) WHERE is_active;
CREATE INDEX device_tokens_user_idx ON device_tokens (user_id) WHERE is_active;

-- =============================================================================
-- CATÁLOGO
-- =============================================================================

CREATE TABLE categories (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name            text NOT NULL,
    description     text,
    position        smallint NOT NULL DEFAULT 0,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);
CREATE UNIQUE INDEX categories_branch_name_uk ON categories (branch_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX categories_branch_active_idx ON categories (branch_id, position) WHERE deleted_at IS NULL AND is_active;
CREATE UNIQUE INDEX categories_id_branch_uk ON categories (id, branch_id);

CREATE TABLE products (
    id                       uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id                uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    category_id              uuid,
    name                     text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    description              text CHECK (description IS NULL OR length(description) <= 2000),
    sku                      text,
    price_cents              bigint NOT NULL CHECK (price_cents >= 0),
    currency                 char(3) NOT NULL DEFAULT 'BRL',
    is_active                boolean NOT NULL DEFAULT true,
    -- D2 (item 1 do Prompt 02): destaque e observações
    is_featured              boolean NOT NULL DEFAULT false,
    notes                    text CHECK (notes IS NULL OR length(notes) <= 1000),
    allows_customer_notes    boolean NOT NULL DEFAULT true,
    preparation_time_minutes integer CHECK (preparation_time_minutes IS NULL OR preparation_time_minutes BETWEEN 0 AND 480),
    position                 smallint NOT NULL DEFAULT 0,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    deleted_at               timestamptz
);
CREATE UNIQUE INDEX products_branch_sku_uk ON products (branch_id, sku) WHERE deleted_at IS NULL AND sku IS NOT NULL;
CREATE INDEX products_menu_idx ON products (branch_id, category_id, position) WHERE deleted_at IS NULL AND is_active;
CREATE INDEX products_featured_idx ON products (branch_id, position) WHERE deleted_at IS NULL AND is_active AND is_featured;
CREATE INDEX products_org_idx ON products (organization_id) WHERE deleted_at IS NULL;

-- FK composta: a categoria PRECISA ser da mesma unidade do produto.
-- SET NULL (category_id) porque anular branch_id violaria NOT NULL (PG 15+).
ALTER TABLE products
    ADD CONSTRAINT products_category_same_branch_fk
    FOREIGN KEY (category_id, branch_id) REFERENCES categories (id, branch_id)
    ON DELETE SET NULL (category_id);

CREATE TABLE product_images (
    id           uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    storage_key  text NOT NULL,
    -- D3 (item 2): variantes geradas no processamento
    thumb_storage_key  text,
    medium_storage_key text,
    content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
    byte_size    integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5 * 1024 * 1024),
    width        integer,
    height       integer,
    blurhash     text,
    alt_text     text,
    position     smallint NOT NULL DEFAULT 0,
    is_primary   boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);
CREATE UNIQUE INDEX product_images_storage_key_uk ON product_images (storage_key);
CREATE UNIQUE INDEX product_images_primary_uk ON product_images (product_id) WHERE is_primary AND deleted_at IS NULL;
CREATE INDEX product_images_product_idx ON product_images (product_id, position) WHERE deleted_at IS NULL;

CREATE TABLE modifier_groups (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name            text NOT NULL,
    min_select      smallint NOT NULL DEFAULT 0 CHECK (min_select >= 0),
    max_select      smallint NOT NULL DEFAULT 1 CHECK (max_select >= 1),
    is_required     boolean NOT NULL DEFAULT false,
    position        smallint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    CONSTRAINT modifier_groups_select_chk CHECK (max_select >= min_select)
);
CREATE UNIQUE INDEX modifier_groups_id_branch_uk ON modifier_groups (id, branch_id);

CREATE TABLE modifier_options (
    id                uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    modifier_group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name              text NOT NULL,
    price_delta_cents bigint NOT NULL DEFAULT 0,
    is_available      boolean NOT NULL DEFAULT true,
    position          smallint NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz
);
CREATE INDEX modifier_options_group_idx ON modifier_options (modifier_group_id, position) WHERE deleted_at IS NULL;

CREATE TABLE product_modifier_groups (
    product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    modifier_group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    position          smallint NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, modifier_group_id),
    -- grupo de adicionais precisa ser da mesma unidade do produto
    CONSTRAINT pmg_group_same_branch_fk FOREIGN KEY (modifier_group_id, branch_id)
        REFERENCES modifier_groups (id, branch_id) ON DELETE CASCADE
);

-- =============================================================================
-- ESTOQUE VIRTUAL
-- =============================================================================

CREATE TABLE virtual_inventory (
    id                   uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id            uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    product_id           uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    mode                 availability_mode NOT NULL DEFAULT 'INFINITE',
    on_hand_qty          integer NOT NULL DEFAULT 0 CHECK (on_hand_qty >= 0),
    reserved_qty         integer NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
    is_manually_sold_out boolean NOT NULL DEFAULT false,
    sold_out_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    sold_out_at          timestamptz,
    reactivated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    reactivated_at       timestamptz,
    low_stock_threshold  integer CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    -- INVARIANTE CENTRAL: reservado nunca ultrapassa o físico.
    CONSTRAINT virtual_inventory_reserved_chk CHECK (reserved_qty <= on_hand_qty),
    CONSTRAINT virtual_inventory_soldout_chk CHECK (
        (is_manually_sold_out = false) OR (sold_out_at IS NOT NULL)
    )
);
CREATE UNIQUE INDEX virtual_inventory_branch_product_uk ON virtual_inventory (branch_id, product_id);
CREATE UNIQUE INDEX virtual_inventory_product_uk ON virtual_inventory (product_id);

CREATE TABLE inventory_movements (
    id                   uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id            uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    virtual_inventory_id uuid NOT NULL REFERENCES virtual_inventory(id) ON DELETE RESTRICT,
    product_id           uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    type                 movement_type NOT NULL,
    quantity_delta       integer NOT NULL,
    on_hand_after        integer NOT NULL CHECK (on_hand_after >= 0),
    reserved_after       integer NOT NULL CHECK (reserved_after >= 0),
    order_id             uuid,
    actor_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_type           actor_type NOT NULL DEFAULT 'SYSTEM',
    reason               text,
    created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_inv_idx ON inventory_movements (virtual_inventory_id, created_at DESC);
CREATE INDEX inventory_movements_order_idx ON inventory_movements (order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER inventory_movements_immutable BEFORE UPDATE OR DELETE ON inventory_movements
    FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE inventory_reservations (
    id                   uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id            uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    order_id             uuid NOT NULL,
    virtual_inventory_id uuid NOT NULL REFERENCES virtual_inventory(id) ON DELETE RESTRICT,
    quantity             integer NOT NULL CHECK (quantity > 0),
    status               reservation_status NOT NULL DEFAULT 'ACTIVE',
    expires_at           timestamptz NOT NULL,
    resolved_at          timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_reservations_expiring_idx ON inventory_reservations (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX inventory_reservations_order_idx ON inventory_reservations (order_id);
CREATE UNIQUE INDEX inventory_reservations_order_inv_uk
    ON inventory_reservations (order_id, virtual_inventory_id) WHERE status = 'ACTIVE';

-- =============================================================================
-- ENTREGA
-- =============================================================================

CREATE TABLE delivery_addresses (
    id            uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    customer_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label         text,
    postal_code   text NOT NULL,
    street        text NOT NULL,
    street_number text NOT NULL,
    complement    text,
    district      text NOT NULL,
    city          text NOT NULL,
    state_code    char(2) NOT NULL,
    reference     text,
    latitude      double precision,
    longitude     double precision,
    is_default    boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);
CREATE INDEX delivery_addresses_customer_idx ON delivery_addresses (customer_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX delivery_addresses_default_uk ON delivery_addresses (customer_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE delivery_zones (
    id               uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id        uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name             text NOT NULL,
    type             delivery_zone_type NOT NULL,
    radius_meters    integer CHECK (radius_meters IS NULL OR radius_meters > 0),
    postal_code_from text,
    postal_code_to   text,
    fee_cents        bigint NOT NULL CHECK (fee_cents >= 0),
    min_order_cents  bigint NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
    eta_minutes      integer NOT NULL DEFAULT 40 CHECK (eta_minutes > 0),
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz,
    CONSTRAINT delivery_zones_shape_chk CHECK (
        (type = 'RADIUS' AND radius_meters IS NOT NULL) OR
        (type = 'POSTAL_RANGE' AND postal_code_from IS NOT NULL AND postal_code_to IS NOT NULL)
    )
);
CREATE INDEX delivery_zones_branch_idx ON delivery_zones (branch_id) WHERE is_active AND deleted_at IS NULL;

-- =============================================================================
-- PEDIDOS
-- =============================================================================

CREATE TABLE order_number_counters (
    branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    business_date date NOT NULL,
    last_number   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, business_date)
);

CREATE TABLE orders (
    id                        uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id                 uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    customer_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    order_number              text NOT NULL,
    status                    order_status NOT NULL DEFAULT 'PENDING',
    fulfillment               fulfillment_type NOT NULL,
    payment_method            payment_method NOT NULL,
    currency                  char(3) NOT NULL DEFAULT 'BRL',
    subtotal_cents            bigint NOT NULL CHECK (subtotal_cents >= 0),
    delivery_fee_cents        bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
    discount_cents            bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    total_cents               bigint NOT NULL CHECK (total_cents >= 0),
    delivery_address_id       uuid REFERENCES delivery_addresses(id) ON DELETE SET NULL,
    delivery_address_snapshot jsonb,
    delivery_zone_id          uuid REFERENCES delivery_zones(id) ON DELETE SET NULL,
    customer_notes            text CHECK (customer_notes IS NULL OR length(customer_notes) <= 500),
    internal_notes            text,
    change_for_cents          bigint CHECK (change_for_cents IS NULL OR change_for_cents >= 0),
    estimated_ready_at        timestamptz,
    reservation_expires_at    timestamptz,
    placed_at                 timestamptz NOT NULL DEFAULT now(),
    confirmed_at              timestamptz,
    ready_at                  timestamptz,
    completed_at              timestamptz,
    cancelled_at              timestamptz,
    cancellation_reason       text,
    client_ip                 inet,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT orders_total_chk CHECK (total_cents = subtotal_cents + delivery_fee_cents - discount_cents),
    CONSTRAINT orders_discount_chk CHECK (discount_cents <= subtotal_cents + delivery_fee_cents),
    CONSTRAINT orders_delivery_chk CHECK (
        (fulfillment = 'DELIVERY' AND delivery_address_snapshot IS NOT NULL) OR
        (fulfillment = 'PICKUP' AND delivery_fee_cents = 0)
    )
);
CREATE UNIQUE INDEX orders_branch_number_uk ON orders (branch_id, order_number);
CREATE INDEX orders_active_queue_idx ON orders (branch_id, status, placed_at DESC)
    WHERE status NOT IN ('DELIVERED','PICKED_UP','CANCELLED','REJECTED','EXPIRED');
CREATE INDEX orders_customer_idx ON orders (customer_id, placed_at DESC);
CREATE INDEX orders_expiring_idx ON orders (reservation_expires_at) WHERE status = 'PENDING';

ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_order_fk
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_order_fk
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;

CREATE TABLE order_items (
    id                        uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    order_id                  uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id                uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name_snapshot     text NOT NULL,
    product_sku_snapshot      text,
    product_image_key_snapshot text,
    unit_price_cents_snapshot bigint NOT NULL CHECK (unit_price_cents_snapshot >= 0),
    quantity                  integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
    options_total_cents       bigint NOT NULL DEFAULT 0,
    line_total_cents          bigint NOT NULL CHECK (line_total_cents >= 0),
    notes                     text CHECK (notes IS NULL OR length(notes) <= 200),
    created_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT order_items_line_total_chk CHECK (
        line_total_cents = (unit_price_cents_snapshot + options_total_cents) * quantity
    )
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id);

CREATE TABLE order_item_options (
    id                         uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    order_item_id              uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    modifier_option_id         uuid REFERENCES modifier_options(id) ON DELETE SET NULL,
    option_name_snapshot       text NOT NULL,
    group_name_snapshot        text NOT NULL,
    price_delta_cents_snapshot bigint NOT NULL,
    quantity                   smallint NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_item_options_item_idx ON order_item_options (order_item_id);

CREATE TABLE order_status_history (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    from_status     order_status,
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
CREATE TRIGGER order_status_history_immutable BEFORE UPDATE OR DELETE ON order_status_history
    FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- =============================================================================
-- PAGAMENTOS
-- =============================================================================

CREATE TABLE payments (
    id                  uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id           uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    method              payment_method NOT NULL,
    status              payment_status NOT NULL DEFAULT 'PENDING',
    amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
    currency            char(3) NOT NULL DEFAULT 'BRL',
    provider            text NOT NULL,
    provider_payment_id text,
    pix_brcode          text,
    pix_txid            text,
    pix_key_last4       text,
    confirmed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at        timestamptz,
    confirmed_ip        inet,
    confirmation_note   text,
    failure_reason      text,
    refunded_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT payments_confirmation_chk CHECK ((status <> 'CONFIRMED') OR (confirmed_at IS NOT NULL))
);
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_branch_idx ON payments (branch_id, status, created_at DESC);
CREATE UNIQUE INDEX payments_order_active_uk ON payments (order_id)
    WHERE status IN ('PENDING','AWAITING_CONFIRMATION','CONFIRMED');

CREATE TABLE payment_events (
    id                uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    payment_id        uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    event_type        text NOT NULL,
    provider          text NOT NULL,
    provider_event_id text,
    payload           jsonb NOT NULL,
    signature_valid   boolean,
    received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_events_provider_event_uk ON payment_events (provider, provider_event_id)
    WHERE provider_event_id IS NOT NULL;
CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, received_at DESC);
CREATE TRIGGER payment_events_immutable BEFORE UPDATE OR DELETE ON payment_events
    FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- =============================================================================
-- ENTREGAS (execução)
-- =============================================================================

CREATE TABLE deliveries (
    id                uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    courier_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    status            delivery_status NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
    fee_cents         bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
    assigned_at       timestamptz,
    dispatched_at     timestamptz,
    delivered_at      timestamptz,
    failure_reason    text,
    proof_type        text CHECK (proof_type IS NULL OR proof_type IN ('PHOTO','CODE','SIGNATURE')),
    proof_storage_key text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deliveries_order_uk ON deliveries (order_id);
CREATE INDEX deliveries_courier_idx ON deliveries (courier_user_id, status);

-- =============================================================================
-- PLATAFORMA
-- =============================================================================

CREATE TABLE audit_logs (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id       uuid REFERENCES branches(id) ON DELETE RESTRICT,
    actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_type      actor_type NOT NULL DEFAULT 'STAFF',
    action          text NOT NULL,
    resource_type   text NOT NULL,
    resource_id     uuid,
    result          audit_result NOT NULL DEFAULT 'SUCCESS',
    ip_address      inet,
    user_agent      text,
    request_id      text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    prev_hash       bytea,
    record_hash     bytea NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (organization_id, resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE outbox_events (
    id              uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id uuid,
    branch_id       uuid,
    aggregate_type  text NOT NULL,
    aggregate_id    uuid NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    attempts        smallint NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text
);
CREATE INDEX outbox_events_pending_idx ON outbox_events (next_attempt_at) WHERE published_at IS NULL;
CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_type, aggregate_id);

CREATE TABLE notifications (
    id                  uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id           uuid REFERENCES branches(id) ON DELETE RESTRICT,
    order_id            uuid REFERENCES orders(id) ON DELETE RESTRICT,
    recipient_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    recipient_address   text,
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
CREATE INDEX notifications_order_idx ON notifications (order_id);
-- Idempotência do consumidor: uma mensagem por (pedido, status, canal).
CREATE UNIQUE INDEX notifications_dedup_uk ON notifications (order_id, template_name, channel)
    WHERE order_id IS NOT NULL;

CREATE TABLE whatsapp_integrations (
    id                       uuid PRIMARY KEY DEFAULT app.uuid_generate_v7(),
    organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    branch_id                uuid REFERENCES branches(id) ON DELETE CASCADE,
    provider                 text NOT NULL DEFAULT 'META_CLOUD_API',
    waba_id                  text,
    phone_number_id          text NOT NULL,
    display_phone_number     text,
    access_token_secret_ref  text NOT NULL,
    webhook_verify_token_ref text,
    app_secret_ref           text,
    template_map             jsonb NOT NULL DEFAULT '{}'::jsonb,
    quality_rating           text,
    is_active                boolean NOT NULL DEFAULT true,
    last_error               text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX whatsapp_integrations_phone_uk ON whatsapp_integrations (phone_number_id) WHERE is_active;

CREATE TABLE idempotency_keys (
    key             text PRIMARY KEY,
    user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
    endpoint        text NOT NULL,
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
    branch_id       uuid REFERENCES branches(id) ON DELETE CASCADE,
    storage_key     text NOT NULL UNIQUE,
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
-- TRIGGERS updated_at
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
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t, t);
    END LOOP;
END $$;
