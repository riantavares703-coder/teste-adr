import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { businessDateFor } from '@plataforma/domain';
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
 * NÚMERO AMIGÁVEL ATRAVÉS DE DIAS DIFERENTES.
 *
 * `order_number_counters` reinicia por (unidade, dia de operação) de
 * propósito — é o que mantém "pedido 12!" curto em vez de crescer sem fim ao
 * longo dos meses. O risco disso é o dia seguinte gerar o MESMO #1001 de
 * ontem: sem a data no índice de unicidade de `orders` (migração 0005), o
 * primeiro pedido de qualquer segundo dia de uma unidade batia de frente
 * com o #1001 já gravado — todo restaurante real bateria nisso no dia 2.
 */
describe('Número do pedido através de dias diferentes', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let f: Fixture;
  let customerToken: string;

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
    f = await seedOrganization(client, { slug: 'acme' });

    const phone = '+5511933333333';
    await seedCustomer(client, phone);
    const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
    await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
    const code = app.get(OtpDeliveryService).getDevCode(phone)!;
    const login = await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code });
    customerToken = login.body.accessToken;
  }, 120_000);

  it('o #1001 de hoje não colide com o #1001 gravado ontem, na MESMA unidade', async () => {
    // Reproduz o estado real de uma unidade que já fechou o primeiro dia de
    // operação: um pedido #1001 concluído ontem, e o contador de ontem já
    // consumido até 1. O branch usa o fuso padrão do schema
    // ('America/Sao_Paulo' — harness.ts não sobrescreve `timezone`).
    const yesterday = businessDateFor(
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      'America/Sao_Paulo',
    );
    const yesterdayCustomer = await seedCustomer(client, '+5511922222222');
    await client.query(
      `INSERT INTO orders (id, organization_id, branch_id, customer_id, order_number, business_date,
                           status, fulfillment, payment_method, subtotal_cents, total_cents, placed_at)
       VALUES ($1,$2,$3,$4,'1001',$5,'DELIVERED','PICKUP','CASH_ON_SITE',2990,2990,
               ($5::date + time '20:00')::timestamptz)`,
      [randomUUID(), f.organizationId, f.branchId, yesterdayCustomer.id, yesterday],
    );
    await client.query(
      `INSERT INTO order_number_counters (branch_id, business_date, last_number) VALUES ($1,$2,1)`,
      [f.branchId, yesterday],
    );

    const res = await request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });

    // Sem a migração 0005 isto falharia com 500: "duplicate key value
    // violates unique constraint orders_branch_number_uk", porque o #1001 de
    // hoje bateria no mesmo índice único que o #1001 de ontem.
    expect(res.status).toBe(201);
    expect(res.body.order.orderNumber).toBe('1001');
  });

  it('dentro do MESMO dia, o número continua incremental (sem regressão)', async () => {
    const first = await request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
    const second = await request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });

    expect(first.body.order.orderNumber).toBe('1001');
    expect(second.body.order.orderNumber).toBe('1002');
  });
});
