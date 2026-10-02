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

const STORE = { latitude: -5.7945, longitude: -35.211 };
const INSIDE = { latitude: -5.8, longitude: -35.21 };
const OUTSIDE = { latitude: -5.9, longitude: -35.21 };
const ADDRESS = {
  postalCode: '59000-000',
  street: 'Av. Hermes da Fonseca',
  streetNumber: '100',
  district: 'Tirol',
  city: 'Natal',
  stateCode: 'RN',
};

describe('Entrega: endereço, zona e taxa', () => {
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
    const phone = '+5584999990000';
    await seedCustomer(client, phone);
    const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
    await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
    const code = app.get(OtpDeliveryService).getDevCode(phone)!;
    const res = await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code });
    customerToken = res.body.accessToken as string;
  }, 120_000);

  async function managerToken() {
    const res = await request(baseUrl).post('/v1/auth/login').send({
      organizationSlug: f.organizationSlug,
      email: f.managerEmail,
      password: f.password,
    });
    return res.body.accessToken as string;
  }

  async function configureZone(extra: Record<string, unknown> = {}) {
    const token = await managerToken();
    return request(baseUrl)
      .put(`/v1/branches/${f.branchId}/delivery-zone`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...STORE, radiusMeters: 3000, feeCents: 550, minOrderCents: 0, etaMinutes: 35, isActive: true, ...extra });
  }

  function addAddress(coords: { latitude: number; longitude: number }) {
    return request(baseUrl)
      .post('/v1/me/addresses')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ ...ADDRESS, ...coords });
  }

  function deliveryOrder(deliveryAddressId?: string) {
    return request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        branchId: f.branchId,
        fulfillment: 'DELIVERY',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
        ...(deliveryAddressId ? { deliveryAddressId } : {}),
      });
  }

  it('a loja configura o ponto e o raio; a configuração volta no GET', async () => {
    await configureZone().then((r) => expect(r.status).toBe(200));
    const token = await managerToken();
    const res = await request(baseUrl)
      .get(`/v1/branches/${f.branchId}/delivery-zone`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({ ...STORE, radiusMeters: 3000, feeCents: 550, configured: true });
  });

  it('configurar de novo atualiza a mesma zona, sem duplicar', async () => {
    await configureZone();
    await configureZone({ feeCents: 800 });
    const zones = await client.query('SELECT fee_cents FROM delivery_zones WHERE branch_id = $1 AND type = \'RADIUS\'', [f.branchId]);
    expect(zones.rowCount).toBe(1);
    expect(Number(zones.rows[0].fee_cents)).toBe(800);
  });

  it('cotação pública: dentro do raio devolve taxa e prazo; fora, não entrega', async () => {
    await configureZone();
    const inside = await request(baseUrl)
      .post('/v1/public/delivery-quote')
      .send({ branchId: f.branchId, postalCode: '59000000', ...INSIDE })
      .expect(201);
    expect(inside.body).toMatchObject({ deliverable: true, feeCents: 550, etaMinutes: 35 });

    const outside = await request(baseUrl)
      .post('/v1/public/delivery-quote')
      .send({ branchId: f.branchId, postalCode: '59000000', ...OUTSIDE })
      .expect(201);
    expect(outside.body.deliverable).toBe(false);
  });

  it('pedido de entrega soma a taxa da zona ao subtotal', async () => {
    await configureZone();
    const address = await addAddress(INSIDE);
    expect(address.status).toBe(201);
    const order = await deliveryOrder(address.body.id);
    expect(order.status).toBe(201);
    expect(order.body.order.deliveryFeeCents).toBe(550);
    expect(order.body.order.totalCents).toBe(order.body.order.subtotalCents + 550);
    expect(order.body.order.deliveryAddressSnapshot).toMatchObject({ street: ADDRESS.street });
  });

  it('endereço fora do raio é recusado com FORA_DA_AREA', async () => {
    await configureZone();
    const address = await addAddress(OUTSIDE);
    const order = await deliveryOrder(address.body.id);
    expect(order.status).toBe(422);
    expect(order.body.code).toBe('FORA_DA_AREA');
  });

  it('sem endereço, a entrega é recusada', async () => {
    await configureZone();
    const order = await deliveryOrder();
    expect(order.body.code).toBe('ENDERECO_OBRIGATORIO');
  });

  it('cliente não consegue configurar a zona da loja', async () => {
    const res = await request(baseUrl)
      .put(`/v1/branches/${f.branchId}/delivery-zone`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ ...STORE, radiusMeters: 3000, feeCents: 0, minOrderCents: 0, etaMinutes: 30, isActive: true });
    expect(res.status).toBe(403);
  });
});
