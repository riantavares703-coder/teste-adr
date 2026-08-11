import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { resetEnvCache } from '../../src/config/env.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@localhost:5433/plataforma_test?host=/tmp';

const ADMIN_URL = TEST_DATABASE_URL.replace(/\/plataforma_test/, '/postgres');

/** Cria o banco de teste do zero e aplica todas as migrações. */
export async function setupDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // Derruba conexões remanescentes de execuções anteriores, senão o DROP falha.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = 'plataforma_test' AND pid <> pg_backend_pid()`,
  );
  await admin.query('DROP DATABASE IF EXISTS plataforma_test');
  await admin.query('CREATE DATABASE plataforma_test');
  await admin.end();
  await runMigrations(TEST_DATABASE_URL);
}

export function configureTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DATA_ENCRYPTION_KEY = 'chave-de-teste-nao-usar-em-producao';
  process.env.PASSWORD_PEPPER = 'pepper-de-teste';
  process.env.MEDIA_STORAGE_DIR = '/var/tmp/plataforma-media-test';
  process.env.ACCESS_TOKEN_TTL_SECONDS = '600';
  resetEnvCache();
}

/**
 * Sobe a aplicação escutando numa porta efêmera.
 *
 * `supertest(app.getHttpServer())` cria um listener NOVO por requisição — com
 * dezenas de chamadas em paralelo isso derruba conexões (ECONNRESET) e mascara
 * o que os testes de concorrência querem medir. Escutando de verdade, todas as
 * requisições chegam ao MESMO servidor, que é exatamente o cenário real.
 */
export async function createTestApp(): Promise<{ app: INestApplication; baseUrl: string }> {
  configureTestEnv();
  const { createApp } = await import('../../src/main.js');
  const app = await createApp();
  await app.init();
  await app.listen(0);
  const url = await app.getUrl();
  // getUrl() devolve [::1] em alguns ambientes; normalizamos para IPv4.
  return { app, baseUrl: url.replace('[::1]', '127.0.0.1') };
}

// ---------------------------------------------------------------------------
// Massa de teste: DUAS franquias concorrentes, para que todo teste de
// isolamento tenha um "outro tenant" real contra o qual falhar.
// ---------------------------------------------------------------------------

export interface Fixture {
  organizationId: string;
  organizationSlug: string;
  branchId: string;
  branchSlug: string;
  secondBranchId: string;
  managerId: string;
  managerEmail: string;
  operatorId: string;
  operatorEmail: string;
  password: string;
  productId: string;
  productPriceCents: number;
  categoryId: string;
}

const PASSWORD = 'senha-de-teste-123456';

export async function seedOrganization(
  client: pg.Client,
  opts: { slug: string; branchSlug?: string },
): Promise<Fixture> {
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const secondBranchId = randomUUID();
  const managerId = randomUUID();
  const operatorId = randomUUID();
  const productId = randomUUID();
  const categoryId = randomUUID();
  const branchSlug = opts.branchSlug ?? 'centro';
  const passwordHash = await hashPassword(PASSWORD);

  await client.query(
    `INSERT INTO organizations (id, slug, legal_name, trade_name, contact_email)
     VALUES ($1, $2, $3, $3, $4)`,
    [organizationId, opts.slug, `${opts.slug} LTDA`, `${opts.slug}@teste.com`],
  );

  for (const [id, slug, name] of [
    [branchId, branchSlug, 'Centro'],
    [secondBranchId, 'zona-sul', 'Zona Sul'],
  ] as const) {
    await client.query(
      `INSERT INTO branches (id, organization_id, slug, name, latitude, longitude, city, state_code)
       VALUES ($1, $2, $3, $4, -23.55, -46.63, 'São Paulo', 'SP')`,
      [id, organizationId, slug, name],
    );
    await client.query(
      `INSERT INTO store_settings (branch_id, organization_id, payment_hold_minutes, min_order_cents)
       VALUES ($1, $2, 15, 0)`,
      [id, organizationId],
    );
    await client.query(
      `INSERT INTO branding_settings (branch_id, organization_id, display_name)
       VALUES ($1, $2, $3)`,
      [id, organizationId, name],
    );
  }

  // Gerente: escopo de organização inteira (branch_id NULL).
  await client.query(
    `INSERT INTO users (id, type, organization_id, email, full_name, password_hash)
     VALUES ($1, 'STAFF', $2, $3, 'Gerente', $4)`,
    [managerId, organizationId, `gerente@${opts.slug}.com`, passwordHash],
  );
  await client.query(
    `INSERT INTO user_roles (id, user_id, role_id, organization_id, branch_id)
     SELECT $1, $2, id, $3, NULL FROM roles WHERE code = 'UNIT_MANAGER'`,
    [randomUUID(), managerId, organizationId],
  );

  // Operador: escopo de UMA unidade apenas.
  await client.query(
    `INSERT INTO users (id, type, organization_id, email, full_name, password_hash)
     VALUES ($1, 'STAFF', $2, $3, 'Operador', $4)`,
    [operatorId, organizationId, `operador@${opts.slug}.com`, passwordHash],
  );
  await client.query(
    `INSERT INTO user_roles (id, user_id, role_id, organization_id, branch_id)
     SELECT $1, $2, id, $3, $4 FROM roles WHERE code = 'OPERATOR'`,
    [randomUUID(), operatorId, organizationId, branchId],
  );

  await client.query(
    `INSERT INTO categories (id, organization_id, branch_id, name, position)
     VALUES ($1, $2, $3, 'Hambúrgueres', 0)`,
    [categoryId, organizationId, branchId],
  );

  await client.query(
    `INSERT INTO products (id, organization_id, branch_id, category_id, name, description, price_cents, is_featured)
     VALUES ($1, $2, $3, $4, 'X-Burger', 'Pão brioche, hambúrguer artesanal, queijo', 2990, true)`,
    [productId, organizationId, branchId, categoryId],
  );
  await client.query(
    `INSERT INTO virtual_inventory (id, organization_id, branch_id, product_id, mode, on_hand_qty)
     VALUES ($1, $2, $3, $4, 'INFINITE', 0)`,
    [randomUUID(), organizationId, branchId, productId],
  );

  // Pix da unidade (chave cifrada com a mesma chave mestra do app em teste).
  const { CryptoService } = await import('../../src/modules/payments/crypto.service.js');
  const crypto = new CryptoService();
  const pixKey = `pix@${opts.slug}.com.br`;
  await client.query(
    `INSERT INTO pix_settings (branch_id, organization_id, key_type, key_encrypted, key_last4,
                               key_fingerprint, merchant_name, merchant_city)
     VALUES ($1, $2, 'EMAIL', $3, $4, $5, $6, 'SAO PAULO')`,
    [
      branchId,
      organizationId,
      crypto.encrypt(pixKey),
      pixKey.slice(-4),
      crypto.fingerprint(pixKey),
      opts.slug.slice(0, 25).toUpperCase(),
    ],
  );

  await client.query(
    `INSERT INTO delivery_zones (id, organization_id, branch_id, name, type, postal_code_from, postal_code_to, fee_cents)
     VALUES ($1, $2, $3, 'Centro', 'POSTAL_RANGE', '01000000', '01999999', 700)`,
    [randomUUID(), organizationId, branchId],
  );

  return {
    organizationId,
    organizationSlug: opts.slug,
    branchId,
    branchSlug,
    secondBranchId,
    managerId,
    managerEmail: `gerente@${opts.slug}.com`,
    operatorId,
    operatorEmail: `operador@${opts.slug}.com`,
    password: PASSWORD,
    productId,
    productPriceCents: 2990,
    categoryId,
  };
}

export async function seedCustomer(
  client: pg.Client,
  phone: string,
): Promise<{ id: string; phone: string }> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, type, phone_e164, full_name, phone_verified_at)
     VALUES ($1, 'CUSTOMER', $2, 'Cliente Teste', now())`,
    [id, phone],
  );
  await client.query(
    `INSERT INTO user_roles (id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE code = 'CUSTOMER'`,
    [randomUUID(), id],
  );
  return { id, phone };
}

export async function hashPassword(password: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const peppered = createHmac('sha256', 'pepper-de-teste').update(password).digest('base64');
  return argonHash(peppered, { memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

/** Limpa dados transacionais entre testes, preservando papéis e permissões. */
export async function truncateTransactional(client: pg.Client): Promise<void> {
  await client.query(`
    TRUNCATE order_item_options, order_items, order_status_history, payments, payment_events,
             inventory_reservations, inventory_movements, orders, order_number_counters,
             outbox_events, notifications, idempotency_keys, audit_logs,
             customer_organization_links, sessions, login_attempts, otp_codes,
             delivery_addresses, media_assets, product_images
    RESTART IDENTITY CASCADE
  `);
}

export async function resetAll(client: pg.Client): Promise<void> {
  await client.query(`
    TRUNCATE order_item_options, order_items, order_status_history, payments, payment_events,
             inventory_reservations, inventory_movements, orders, order_number_counters,
             outbox_events, notifications, idempotency_keys, audit_logs,
             customer_organization_links, sessions, login_attempts, otp_codes,
             delivery_addresses, media_assets, product_images, product_modifier_groups,
             modifier_options, modifier_groups, virtual_inventory, products, categories,
             delivery_zones, pix_settings, branding_settings, store_settings, business_hours,
             user_roles, device_tokens, mfa_credentials, users, branches, organizations
    RESTART IDENTITY CASCADE
  `);
}
