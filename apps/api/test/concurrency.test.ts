import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  TEST_DATABASE_URL,
  createTestApp,
  resetAll,
  seedCustomer,
  seedOrganization,
  setupDatabase,
  type Fixture,
} from './helpers/harness.js';

/**
 * ITEM 4 DO PROMPT 02 — CONCORRÊNCIA.
 *
 * "Cliente A vê 1 unidade / Cliente B vê 1 unidade / Ambos compram /
 *  Resultado: estoque = -1. Isso NÃO pode acontecer."
 *
 * Estes testes disparam requisições HTTP REAIS em paralelo, atravessando toda a
 * pilha (guard, RLS, transação, reserva atômica). Não há mock em lugar nenhum.
 */
describe('Concorrência no estoque virtual', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let fixture: Fixture;
  let customerTokens: string[];

  beforeAll(async () => {
    await setupDatabase();
    ({ app, baseUrl } = await createTestApp());
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  }, 180_000);

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await resetAll(client);
    fixture = await seedOrganization(client, { slug: 'acme' });
    customerTokens = [];
    // 60 clientes distintos, cada um com sua própria sessão.
    for (let i = 0; i < 60; i++) {
      const phone = `+5511900${String(i).padStart(6, '0')}`;
      await seedCustomer(client, phone);
      customerTokens.push(await loginCustomer(app, baseUrl, phone));
    }
  }, 180_000);

  async function setStock(quantity: number): Promise<void> {
    await client.query(
      `UPDATE virtual_inventory SET mode = 'LIMITED', on_hand_qty = $1, reserved_qty = 0
        WHERE product_id = $2`,
      [quantity, fixture.productId],
    );
  }

  async function readInventory(): Promise<{ onHand: number; reserved: number }> {
    const { rows } = await client.query(
      'SELECT on_hand_qty, reserved_qty FROM virtual_inventory WHERE product_id = $1',
      [fixture.productId],
    );
    return { onHand: rows[0].on_hand_qty, reserved: rows[0].reserved_qty };
  }

  function buyOne(token: string) {
    return request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        branchId: fixture.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: fixture.productId, quantity: 1 }],
      });
  }

  it('40 clientes disputando 1 unidade: exatamente 1 vence', async () => {
    await setStock(1);

    const results = await Promise.all(customerTokens.slice(0, 40).map((t) => buyOne(t)));

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    if (created.length !== 1) {
      const byStatus = new Map<number, unknown>();
      for (const r of results) if (!byStatus.has(r.status)) byStatus.set(r.status, r.body);
      console.log('DIAG', [...byStatus].map(([st, b]) => `${st}: ${JSON.stringify(b).slice(0, 200)}`));
    }

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(39);
    expect(rejected[0]!.body.code).toBe('PRODUTO_INDISPONIVEL');

    const { onHand, reserved } = await readInventory();
    expect(onHand).toBe(1);
    expect(reserved).toBe(1); // reservado, não negativo

    // E o mais importante: nenhum pedido a mais existe no banco.
    const { rows } = await client.query('SELECT count(*)::int AS n FROM orders');
    expect(rows[0].n).toBe(1);
  }, 120_000);

  it('60 clientes disputando 10 unidades: exatamente 10 vencem', async () => {
    await setStock(10);

    const results = await Promise.all(customerTokens.map((t) => buyOne(t)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(50);

    const { onHand, reserved } = await readInventory();
    expect(onHand).toBe(10);
    expect(reserved).toBe(10);
  }, 120_000);

  it('estoque NUNCA fica negativo, mesmo com quantidades variadas', async () => {
    await setStock(7);

    // Pedidos de 1, 2 e 3 unidades misturados: a soma reservada não pode passar de 7.
    const results = await Promise.all(
      customerTokens.slice(0, 30).map((token, i) =>
        request(baseUrl)
          .post('/v1/orders')
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            branchId: fixture.branchId,
            fulfillment: 'PICKUP',
            paymentMethod: 'CASH_ON_SITE',
            items: [{ productId: fixture.productId, quantity: (i % 3) + 1 }],
          }),
      ),
    );

    const { onHand, reserved } = await readInventory();
    expect(reserved).toBeLessThanOrEqual(onHand);
    expect(reserved).toBeGreaterThanOrEqual(0);

    // A soma das reservas ativas bate exatamente com o contador.
    const { rows } = await client.query(
      `SELECT COALESCE(sum(quantity), 0)::int AS total
         FROM inventory_reservations WHERE status = 'ACTIVE'`,
    );
    expect(rows[0].total).toBe(reserved);

    const accepted = results.filter((r) => r.status === 201).length;
    expect(accepted).toBeGreaterThan(0);
  }, 120_000);

  it('numeração amigável é única por unidade sob concorrência', async () => {
    await setStock(60);

    const results = await Promise.all(customerTokens.map((t) => buyOne(t)));
    const created = results.filter((r) => r.status === 201);
    expect(created.length).toBe(60);

    const numbers = created.map((r) => r.body.order.orderNumber);
    expect(new Set(numbers).size).toBe(60);
  }, 120_000);

  it('o razão de movimentos reconstrói exatamente o saldo corrente', async () => {
    await setStock(5);
    await Promise.all(customerTokens.slice(0, 20).map((t) => buyOne(t)));

    // Replay do razão: somar os deltas de reserva reconstrói o saldo corrente.
    // (Comparar apenas a "última linha" seria frágil sob concorrência, porque
    // now() é o instante de início da TRANSAÇÃO, não da escrita.)
    const { rows } = await client.query(
      `SELECT COALESCE(sum(quantity_delta), 0)::int AS total
         FROM inventory_movements
        WHERE product_id = $1
          AND type IN ('RESERVE','COMMIT','RELEASE','EXPIRE_RELEASE')`,
      [fixture.productId],
    );
    const { reserved } = await readInventory();
    expect(rows[0].total).toBe(reserved);
  }, 120_000);
});

async function loginCustomer(
  app: INestApplication,
  baseUrl: string,
  phone: string,
): Promise<string> {
  const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
  await request(baseUrl).post('/v1/auth/otp/request').send({ phone }).expect(201);
  const code = app.get(OtpDeliveryService).getDevCode(phone);
  const response = await request(baseUrl)
    .post('/v1/auth/otp/verify')
    .send({ phone, code })
    .expect(201);
  return response.body.accessToken;
}
