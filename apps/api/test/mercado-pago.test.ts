import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { validateBrCodeChecksum } from '@plataforma/domain';
import {
  TEST_DATABASE_URL,
  createTestApp,
  resetAll,
  seedCustomer,
  seedOrganization,
  setupDatabase,
  type Fixture,
} from './helpers/harness.js';
import { VALID_TOKEN, installFakeMercadoPago } from './helpers/fake-mercado-pago.js';
import { PaymentsService } from '../src/modules/payments/payments.service.js';
import { OrderingService } from '../src/modules/ordering/ordering.service.js';

describe('Pix via Mercado Pago', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let f: Fixture;
  let customerToken: string;
  let mp: ReturnType<typeof installFakeMercadoPago>;

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
    mp = installFakeMercadoPago();
    const phone = '+5511933333333';
    await seedCustomer(client, phone);
    const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
    await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
    const code = app.get(OtpDeliveryService).getDevCode(phone)!;
    const res = await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code });
    customerToken = res.body.accessToken as string;
  }, 120_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function managerToken() {
    const res = await request(baseUrl).post('/v1/auth/login').send({
      organizationSlug: f.organizationSlug,
      email: f.managerEmail,
      password: f.password,
    });
    return res.body.accessToken as string;
  }

  function savePix(token: string, mercadoPagoAccessToken?: string | null) {
    return request(baseUrl)
      .put(`/v1/branches/${f.branchId}/pix-settings`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        keyType: 'EMAIL',
        key: 'dono@restaurante.com.br',
        merchantName: 'Loja',
        merchantCity: 'SAO PAULO',
        ...(mercadoPagoAccessToken === undefined ? {} : { mercadoPagoAccessToken }),
      });
  }

  async function placePixOrder() {
    return request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 1 }],
      });
  }

  async function configureMercadoPago() {
    const token = await managerToken();
    await savePix(token, VALID_TOKEN).expect(200);
  }

  async function paymentRow(orderId: string) {
    const r = await client.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    return r.rows[0];
  }

  it('recusa um access token que o Mercado Pago não reconhece, sem salvar nada', async () => {
    const token = await managerToken();
    const res = await savePix(token, 'APP_USR-token-errado-que-tem-mais-de-20-chars');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MERCADO_PAGO_TOKEN_INVALIDO');
    const row = await client.query('SELECT mp_access_token_encrypted FROM pix_settings WHERE branch_id=$1', [f.branchId]);
    expect(row.rows[0]?.mp_access_token_encrypted ?? null).toBeNull();
  });

  it('distingue "token recusado" de "Mercado Pago inalcançável" ao salvar', async () => {
    mp.state.down = true;
    const token = await managerToken();
    const res = await savePix(token, VALID_TOKEN);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MERCADO_PAGO_INDISPONIVEL');
  });

  it('guarda o token cifrado e nunca o devolve', async () => {
    await configureMercadoPago();
    const token = await managerToken();
    const res = await request(baseUrl)
      .get(`/v1/branches/${f.branchId}/pix-settings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.mercadoPagoConfigured).toBe(true);
    expect(res.body.mercadoPagoTokenMasked).toBe('•••abcd');
    expect(JSON.stringify(res.body)).not.toContain(VALID_TOKEN);

    const row = await client.query('SELECT mp_access_token_encrypted FROM pix_settings WHERE branch_id=$1', [f.branchId]);
    expect(Buffer.from(row.rows[0].mp_access_token_encrypted).toString('utf8')).not.toContain(VALID_TOKEN);
  });

  it('cobra EXATAMENTE o total do pedido e entrega o código do Mercado Pago', async () => {
    await configureMercadoPago();
    const created = await placePixOrder();
    expect(created.status).toBe(201);

    expect(mp.state.created).toHaveLength(1);
    expect(mp.state.created[0]).toMatchObject({
      transaction_amount: created.body.order.totalCents / 100,
      payment_method_id: 'pix',
      external_reference: created.body.order.id,
    });

    const payment = await request(baseUrl)
      .get(`/v1/orders/${created.body.order.id}/payment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(200);
    expect(payment.body.provider).toBe('MERCADO_PAGO');
    expect(payment.body.pixBrcode).toMatch(/^00020126MPCODE\d+$/);
    expect(payment.body.automaticConfirmation).toBe(true);
    expect(payment.body.amountCents).toBe(created.body.order.totalCents);
  });

  it('confirma sozinho quando o Mercado Pago aprova, e só uma vez', async () => {
    await configureMercadoPago();
    const created = await placePixOrder();
    const orderId = created.body.order.id as string;
    const svc = app.get(PaymentsService);

    expect(await svc.reconcileMercadoPago()).toBe(0);
    expect((await paymentRow(orderId)).status).toBe('AWAITING_CONFIRMATION');

    mp.payments.get(String((await paymentRow(orderId)).provider_payment_id))!.status = 'approved';
    expect(await svc.reconcileMercadoPago()).toBe(1);

    const row = await paymentRow(orderId);
    expect(row.status).toBe('CONFIRMED');
    expect(row.confirmed_by).toBeNull();
    expect(row.confirmation_note).toContain('Mercado Pago');

    const audit = await client.query(`SELECT 1 FROM audit_logs WHERE action = 'payment.confirmed_by_provider'`);
    expect(audit.rowCount).toBe(1);
    expect(await svc.reconcileMercadoPago()).toBe(0);
  });

  it('NÃO confirma se o valor aprovado difere do pedido, e deixa rastro', async () => {
    await configureMercadoPago();
    const created = await placePixOrder();
    const orderId = created.body.order.id as string;
    const remote = mp.payments.get(String((await paymentRow(orderId)).provider_payment_id))!;
    remote.status = 'approved';
    remote.transaction_amount = 0.01;

    expect(await app.get(PaymentsService).reconcileMercadoPago()).toBe(0);
    expect((await paymentRow(orderId)).status).toBe('AWAITING_CONFIRMATION');
    const audit = await client.query(`SELECT 1 FROM audit_logs WHERE action = 'payment.provider_mismatch'`);
    expect(audit.rowCount).toBe(1);
  });

  it('pagamento rejeitado vira FAILED', async () => {
    await configureMercadoPago();
    const created = await placePixOrder();
    const orderId = created.body.order.id as string;
    mp.payments.get(String((await paymentRow(orderId)).provider_payment_id))!.status = 'rejected';

    await app.get(PaymentsService).reconcileMercadoPago();
    expect((await paymentRow(orderId)).status).toBe('FAILED');
  });

  it('com o Mercado Pago fora do ar, a loja continua vendendo com Pix estático', async () => {
    await configureMercadoPago();
    mp.state.down = true;

    const created = await placePixOrder();
    expect(created.status).toBe(201);
    const payment = await request(baseUrl)
      .get(`/v1/orders/${created.body.order.id}/payment`)
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(200);
    expect(payment.body.provider).toBe('MANUAL_PIX');
    expect(payment.body.automaticConfirmation).toBe(false);
    expect(validateBrCodeChecksum(payment.body.pixBrcode)).toBe(true);
  });

  it('pedido já pago não é expirado pelo relógio da reserva', async () => {
    await configureMercadoPago();
    const created = await placePixOrder();
    const orderId = created.body.order.id as string;
    mp.payments.get(String((await paymentRow(orderId)).provider_payment_id))!.status = 'approved';
    await app.get(PaymentsService).reconcileMercadoPago();

    await client.query(`UPDATE orders SET reservation_expires_at = now() - interval '1 hour' WHERE id = $1`, [orderId]);
    await app.get(OrderingService).expireStaleOrders();

    const order = await client.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(order.rows[0].status).toBe('PENDING');
  });
});
