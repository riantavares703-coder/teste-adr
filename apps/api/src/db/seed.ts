import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * Massa inicial de um restaurante demonstrativo.
 *
 * Roda na PRIMEIRA execução do launcher, para que o dono do restaurante veja um
 * cardápio funcionando em vez de uma tela vazia — e possa trocar os produtos
 * pelos dele depois.
 *
 * É IDEMPOTENTE: o launcher chama a cada inicialização e, se a organização já
 * existe, nada é reinserido. Isso evita duplicar cardápio a cada clique duplo.
 */

export const DEMO = {
  organizationSlug: 'demo',
  branchSlug: 'centro',
  adminEmail: 'admin@demo.local',
  /** Mínimo de 12 caracteres exigido por PasswordService.validatePolicy. */
  adminPassword: 'restaurante123',
} as const;

interface SeedResult {
  created: boolean;
  organizationSlug: string;
  branchSlug: string;
  adminEmail: string;
  adminPassword: string;
}

const CATEGORIES: ReadonlyArray<{
  name: string;
  products: ReadonlyArray<{
    name: string;
    description: string;
    priceCents: number;
    featured?: boolean;
  }>;
}> = [
  {
    name: 'Hambúrgueres',
    products: [
      {
        name: 'X-Burger',
        description: 'Pão brioche, hambúrguer artesanal 180g, queijo prato',
        priceCents: 2990,
        featured: true,
      },
      {
        name: 'X-Salada',
        description: 'Pão brioche, hambúrguer 180g, queijo, alface e tomate',
        priceCents: 3290,
      },
      {
        name: 'X-Bacon',
        description: 'Pão brioche, hambúrguer 180g, queijo, bacon crocante',
        priceCents: 3490,
        featured: true,
      },
    ],
  },
  {
    name: 'Bebidas',
    products: [
      { name: 'Refrigerante Lata', description: '350ml, gelado', priceCents: 600 },
      { name: 'Suco Natural', description: 'Laranja ou limão, 400ml', priceCents: 990 },
      { name: 'Água Mineral', description: 'Com ou sem gás, 500ml', priceCents: 400 },
    ],
  },
  {
    name: 'Sobremesas',
    products: [
      { name: 'Pudim de Leite', description: 'Fatia individual', priceCents: 1200 },
      { name: 'Brownie', description: 'Com sorvete de creme', priceCents: 1490 },
    ],
  },
];

export async function seedDemo(connectionString: string): Promise<SeedResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const existing = await client.query('SELECT 1 FROM organizations WHERE slug = $1', [
      DEMO.organizationSlug,
    ]);
    if (existing.rows.length > 0) {
      return { created: false, ...DEMO };
    }

    // Os serviços reais do app, não uma reimplementação: o hash precisa casar
    // exatamente com o que o login verifica, e a chave Pix com o que o
    // pagamento decifra.
    const { PasswordService } = await import('../modules/auth/password.service.js');
    const { CryptoService } = await import('../modules/payments/crypto.service.js');
    const passwords = new PasswordService();
    const crypto = new CryptoService();

    const organizationId = randomUUID();
    const branchId = randomUUID();
    const adminId = randomUUID();

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO organizations (id, slug, legal_name, trade_name, contact_email)
       VALUES ($1, $2, 'Restaurante Demo LTDA', 'Restaurante Demo', $3)`,
      [organizationId, DEMO.organizationSlug, DEMO.adminEmail],
    );

    await client.query(
      `INSERT INTO branches (id, organization_id, slug, name, latitude, longitude, city, state_code)
       VALUES ($1, $2, $3, 'Unidade Centro', -23.55, -46.63, 'São Paulo', 'SP')`,
      [branchId, organizationId, DEMO.branchSlug],
    );

    await client.query(
      `INSERT INTO store_settings (branch_id, organization_id, preparation_time_minutes, min_order_cents)
       VALUES ($1, $2, 20, 0)`,
      [branchId, organizationId],
    );

    await client.query(
      `INSERT INTO branding_settings (branch_id, organization_id, display_name)
       VALUES ($1, $2, 'Restaurante Demo')`,
      [branchId, organizationId],
    );

    // FRANCHISE_ADMIN: administra a organização inteira, então o dono enxerga
    // aparência e indicadores sem precisar de um segundo usuário.
    await client.query(
      `INSERT INTO users (id, type, organization_id, email, full_name, password_hash)
       VALUES ($1, 'STAFF', $2, $3, 'Administrador', $4)`,
      [adminId, organizationId, DEMO.adminEmail, await passwords.hash(DEMO.adminPassword)],
    );
    await client.query(
      `INSERT INTO user_roles (id, user_id, role_id, organization_id, branch_id)
       SELECT $1, $2, id, $3, NULL FROM roles WHERE code = 'FRANCHISE_ADMIN'`,
      [randomUUID(), adminId, organizationId],
    );

    for (const [position, category] of CATEGORIES.entries()) {
      const categoryId = randomUUID();
      await client.query(
        `INSERT INTO categories (id, organization_id, branch_id, name, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [categoryId, organizationId, branchId, category.name, position],
      );

      for (const product of category.products) {
        const productId = randomUUID();
        await client.query(
          `INSERT INTO products (id, organization_id, branch_id, category_id, name,
                                 description, price_cents, is_featured)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            productId,
            organizationId,
            branchId,
            categoryId,
            product.name,
            product.description,
            product.priceCents,
            product.featured ?? false,
          ],
        );
        // INFINITE: o restaurante demo nunca esgota. Quem quiser estoque
        // limitado troca o modo na tela de Estoque.
        await client.query(
          `INSERT INTO virtual_inventory (id, organization_id, branch_id, product_id, mode, on_hand_qty)
           VALUES ($1, $2, $3, $4, 'INFINITE', 0)`,
          [randomUUID(), organizationId, branchId, productId],
        );
      }
    }

    const pixKey = 'demo@restaurante.local';
    await client.query(
      `INSERT INTO pix_settings (branch_id, organization_id, key_type, key_encrypted, key_last4,
                                 key_fingerprint, merchant_name, merchant_city)
       VALUES ($1, $2, 'EMAIL', $3, $4, $5, 'RESTAURANTE DEMO', 'SAO PAULO')`,
      [
        branchId,
        organizationId,
        crypto.encrypt(pixKey),
        pixKey.slice(-4),
        crypto.fingerprint(pixKey),
      ],
    );

    await client.query('COMMIT');
    return { created: true, ...DEMO };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não definida');
    process.exit(1);
  }
  seedDemo(url)
    .then((result) => {
      console.log(
        result.created
          ? `Restaurante demo criado. Acesso: ${result.adminEmail} / ${result.adminPassword}`
          : 'Restaurante demo já existia; nada foi alterado.',
      );
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
