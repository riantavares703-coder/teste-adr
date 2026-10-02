import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { parseEmv, validateBrCodeChecksum } from '@plataforma/domain';
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

/**
 * DINHEIRO. Cada teste aqui protege uma forma concreta de cobrar errado:
 * valor diferente do pedido, cobrança dupla, confirmação dupla, pedido pago
 * perdido, arredondamento.
 */
describe('Dinheiro: o valor cobrado é exatamente o do pedido', () => {
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
    const phone = '+5511977770000';
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

  async function staffToken() {
    const res = await request(baseUrl).post('/v1/auth/login').send({
      organizationSlug: f.organizationSlug,
      email: f.operatorEmail,
      password: f.password,
    });
    return res.body.accessToken as string;
  }

  async function addProduct(priceCents: number): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO products (id, organization_id, branch_id, category_id, name, price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, f.organizationId, f.branchId, f.categoryId, `Item ${priceCents}`, priceCents],
    );
    await client.query(
      `INSERT INTO virtual_inventory (id, organization_id, branch_id, product_id, mode, on_hand_qty)
       VALUES ($1, $2, $3, $4, 'INFINITE', 0)`,
      [randomUUID(), f.organizationId, f.branchId, id],
    );
    return id;
  }

  function placeOrder(items: Array<{ productId: string; quantity: number }>, extra: Record<string, unknown> = {}, key = randomUUID()) {
    return request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', key)
      .send({ branchId: f.branchId, fulfillment: 'PICKUP', paymentMethod: 'PIX', items, ...extra });
  }

  async function assertLedgerConsistent() {
    // Invariante global: nenhum pagamento diverge do total do seu pedido.
    const { rows } = await client.query(
      `SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.amount_cents <> o.total_cents`,
    );
    expect(rows).toEqual([]);
  }

  it('várias linhas: pagamento e BR Code carregam exatamente o total do pedido', async () => {
    const cheap = await addProduct(1007);
    const res = await placeOrder([
      { productId: f.productId, quantity: 3 }, // 3 x 29,90
      { productId: cheap, quantity: 2 }, //       2 x 10,07
    ]);
    expect(res.status).toBe(201);
    expect(res.body.order.totalCents).toBe(3 * 2990 + 2 * 1007); // 10984
    expect(res.body.payment.amountCents).toBe(10_984);

    const fields = parseEmv(res.body.payment.pixBrcode);
    expect(fields['54']).toBe('109.84');
    expect(validateBrCodeChecksum(res.body.payment.pixBrcode)).toBe(true);
    await assertLedgerConsistent();
  });

  it('o cliente não consegue impor preço: campos de valor são recusados', async () => {
    for (const field of ['priceCents', 'totalCents', 'subtotalCents', 'discountCents', 'deliveryFeeCents']) {
      const res = await placeOrder([{ productId: f.productId, quantity: 1 }], { [field]: 1 });
      expect(res.status, field).toBe(400);
    }
    const { rows } = await client.query('SELECT count(*)::int AS n FROM orders');
    expect(rows[0].n).toBe(0);
  });

  it('item com preço enviado dentro de items também é recusado', async () => {
    const res = await request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 1, unitPriceCents: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it('mudar o preço do produto depois do pedido não altera o total nem a cobrança', async () => {
    const res = await placeOrder([{ productId: f.productId, quantity: 2 }]);
    await client.query('UPDATE products SET price_cents = 99900 WHERE id = $1', [f.productId]);

    const { rows } = await client.query(
      `SELECT o.total_cents AS order_total, p.amount_cents AS charged, i.unit_price_cents_snapshot AS snap
         FROM orders o JOIN payments p ON p.order_id = o.id JOIN order_items i ON i.order_id = o.id
        WHERE o.id = $1`,
      [res.body.order.id],
    );
    expect(Number(rows[0].order_total)).toBe(5980);
    expect(Number(rows[0].charged)).toBe(5980);
    expect(Number(rows[0].snap)).toBe(2990);
  });

  it('total desatualizado no cliente: recusa e NÃO cria pedido, pagamento nem reserva', async () => {
    const res = await placeOrder([{ productId: f.productId, quantity: 1 }], { expectedTotalCents: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRECO_ALTERADO');
    for (const table of ['orders', 'payments', 'order_items']) {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('mesma Idempotency-Key duas vezes: um único pedido e uma única cobrança', async () => {
    const key = randomUUID();
    const first = await placeOrder([{ productId: f.productId, quantity: 1 }], {}, key);
    const second = await placeOrder([{ productId: f.productId, quantity: 1 }], {}, key);
    expect(first.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(second.body.replayed).toBe(true);

    const orders = await client.query('SELECT count(*)::int AS n FROM orders');
    const payments = await client.query('SELECT count(*)::int AS n FROM payments');
    expect(orders.rows[0].n).toBe(1);
    expect(payments.rows[0].n).toBe(1);
  });

  it('6 envios simultâneos com a mesma chave (toque duplo / rede ruim): um pedido só', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => placeOrder([{ productId: f.productId, quantity: 1 }], {}, key)),
    );
    const ids = new Set(results.filter((r) => r.status < 300).map((r) => r.body.order.id));
    expect(ids.size).toBe(1);
    const orders = await client.query('SELECT count(*)::int AS n FROM orders');
    const payments = await client.query('SELECT count(*)::int AS n FROM payments');
    expect(orders.rows[0].n).toBe(1);
    expect(payments.rows[0].n).toBe(1);
    await assertLedgerConsistent();
  });

  it('confirmação manual simultânea: só uma vale, as outras são conflito, auditoria única', async () => {
    const created = await placeOrder([{ productId: f.productId, quantity: 1 }]);
    const { rows } = await client.query('SELECT id FROM payments WHERE order_id = $1', [created.body.order.id]);
    const token = await staffToken();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(baseUrl)
          .post(`/v1/branches/${f.branchId}/payments/${rows[0].id}/confirm`)
          .set('Authorization', `Bearer ${token}`)
          .send({}),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const audit = await client.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'payment.confirmed_manually'`);
    expect(audit.rows[0].n).toBe(1);
  });

  it('recusar ou cancelar pelo operador também encerra a cobrança aberta', async () => {
    const token = await staffToken();
    for (const to of ['REJECTED', 'CANCELLED'] as const) {
      const created = await placeOrder([{ productId: f.productId, quantity: 1 }]);
      const res = await request(baseUrl)
        .post(`/v1/branches/${f.branchId}/orders/${created.body.order.id}/transition`)
        .set('Authorization', `Bearer ${token}`)
        .send({ to, reason: 'sem estoque' });
      expect(res.status, to).toBe(201);
      const pay = (await client.query('SELECT status FROM payments WHERE order_id=$1', [created.body.order.id])).rows[0];
      expect(pay.status, to).toBe('CANCELLED');
    }
  });

  it('o cliente não pode confirmar o próprio pagamento', async () => {
    const created = await placeOrder([{ productId: f.productId, quantity: 1 }]);
    const { rows } = await client.query('SELECT id FROM payments WHERE order_id = $1', [created.body.order.id]);
    const res = await request(baseUrl)
      .post(`/v1/branches/${f.branchId}/payments/${rows[0].id}/confirm`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({});
    expect(res.status).toBe(403);
    const after = await client.query('SELECT status FROM payments WHERE id = $1', [rows[0].id]);
    expect(after.rows[0].status).toBe('AWAITING_CONFIRMATION');
  });

  it('pedido cancelado não pode ter o pagamento confirmado depois', async () => {
    const created = await placeOrder([{ productId: f.productId, quantity: 1 }]);
    await request(baseUrl)
      .post(`/v1/orders/${created.body.order.id}/cancel`)
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ reason: 'desisti' });
    const { rows } = await client.query('SELECT id, status FROM payments WHERE order_id = $1', [created.body.order.id]);
    expect(rows[0].status).toBe('CANCELLED');

    const token = await staffToken();
    const res = await request(baseUrl)
      .post(`/v1/branches/${f.branchId}/payments/${rows[0].id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(409);
  });

  describe('Mercado Pago', () => {
    let mp: ReturnType<typeof installFakeMercadoPago>;

    beforeEach(async () => {
      mp = installFakeMercadoPago();
      const login = await request(baseUrl).post('/v1/auth/login').send({
        organizationSlug: f.organizationSlug,
        email: f.managerEmail,
        password: f.password,
      });
      await request(baseUrl)
        .put(`/v1/branches/${f.branchId}/pix-settings`)
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({
          keyType: 'EMAIL',
          key: 'dono@restaurante.com.br',
          merchantName: 'Loja',
          merchantCity: 'NATAL',
          mercadoPagoAccessToken: VALID_TOKEN,
        })
        .expect(200);
    });

    // Preços em que `cents / 100` não é exato em ponto flutuante (ex.: 1007 / 100 = 10.07).
    const HOSTILE = [1, 7, 29, 57, 1007, 1999, 2990, 3333, 8_190, 12_345, 99_999];

    it.each(HOSTILE)('preço de %i centavos: cobra e confirma sem erro de arredondamento', async (cents) => {
      const productId = await addProduct(cents);
      const created = await placeOrder([{ productId, quantity: 1 }]);
      expect(created.status).toBe(201);
      const charge = mp.state.created.at(-1)!;
      // O que vai para o Mercado Pago, lido de volta em centavos, é o total do pedido.
      expect(Math.round((charge.transaction_amount as number) * 100)).toBe(cents);
      expect(created.body.payment.amountCents).toBe(cents);

      const row = (await client.query('SELECT provider_payment_id FROM payments WHERE order_id=$1', [created.body.order.id])).rows[0];
      mp.payments.get(String(row.provider_payment_id))!.status = 'approved';
      expect(await app.get(PaymentsService).reconcileMercadoPago()).toBe(1);
      await assertLedgerConsistent();
    });

    it('4 conciliações simultâneas do mesmo pagamento: confirma uma vez só', async () => {
      const created = await placeOrder([{ productId: f.productId, quantity: 1 }]);
      const row = (await client.query('SELECT provider_payment_id FROM payments WHERE order_id=$1', [created.body.order.id])).rows[0];
      mp.payments.get(String(row.provider_payment_id))!.status = 'approved';

      const svc = app.get(PaymentsService);
      const counts = await Promise.all([1, 2, 3, 4].map(() => svc.reconcileMercadoPago()));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);

      const audit = await client.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'payment.confirmed_by_provider'`);
      expect(audit.rows[0].n).toBe(1);
      const outbox = await client.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'payment.confirmed'`);
      expect(outbox.rows[0].n).toBe(1);
    });

    it('Pix pago DEPOIS de o pedido ser cancelado: não confirma, e sinaliza o estorno', async () => {
      const created = await placeOrder([{ productId: f.productId, quantity: 1 }]);
      const orderId = created.body.order.id as string;
      await request(baseUrl)
        .post(`/v1/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ reason: 'desisti' })
        .expect(201);

      const row = (await client.query('SELECT id, provider_payment_id FROM payments WHERE order_id=$1', [orderId])).rows[0];
      mp.payments.get(String(row.provider_payment_id))!.status = 'approved'; // o cliente pagou mesmo assim

      const svc = app.get(PaymentsService);
      expect(await svc.reconcileMercadoPago()).toBe(0);
      const after = (await client.query('SELECT status, failure_reason FROM payments WHERE id=$1', [row.id])).rows[0];
      expect(after.status).toBe('CANCELLED');
      expect(after.failure_reason).toContain('estornar');
      const audit = await client.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'payment.received_after_cancel'`);
      expect(audit.rows[0].n).toBe(1);

      // Rodar de novo não duplica o alerta.
      await svc.reconcileMercadoPago();
      const again = await client.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'payment.received_after_cancel'`);
      expect(again.rows[0].n).toBe(1);
    });

    it('pagamento aprovado para OUTRO pedido (referência trocada) não confirma este', async () => {
      const a = await placeOrder([{ productId: f.productId, quantity: 1 }]);
      const rowA = (await client.query('SELECT provider_payment_id FROM payments WHERE order_id=$1', [a.body.order.id])).rows[0];
      const remote = mp.payments.get(String(rowA.provider_payment_id))!;
      remote.status = 'approved';
      remote.external_reference = randomUUID();

      expect(await app.get(PaymentsService).reconcileMercadoPago()).toBe(0);
      const status = (await client.query('SELECT status FROM payments WHERE order_id=$1', [a.body.order.id])).rows[0].status;
      expect(status).toBe('AWAITING_CONFIRMATION');
    });

    it('valor aprovado MENOR que o pedido não confirma; MAIOR também não (exige igualdade)', async () => {
      for (const delta of [-0.01, 0.01]) {
        const created = await placeOrder([{ productId: f.productId, quantity: 1 }]);
        const row = (await client.query('SELECT provider_payment_id FROM payments WHERE order_id=$1', [created.body.order.id])).rows[0];
        const remote = mp.payments.get(String(row.provider_payment_id))!;
        remote.status = 'approved';
        remote.transaction_amount = Number((remote.transaction_amount + delta).toFixed(2));
        expect(await app.get(PaymentsService).reconcileMercadoPago()).toBe(0);
      }
      const paid = await client.query(`SELECT count(*)::int AS n FROM payments WHERE status = 'CONFIRMED'`);
      expect(paid.rows[0].n).toBe(0);
    });

    it('o Mercado Pago cai no meio do pedido: cai para Pix estático e o valor continua exato', async () => {
      mp.state.down = true;
      const created = await placeOrder([{ productId: f.productId, quantity: 2 }]);
      expect(created.status).toBe(201);
      expect(created.body.payment.provider).toBe('MANUAL_PIX');
      expect(parseEmv(created.body.payment.pixBrcode)['54']).toBe('59.80');
      await assertLedgerConsistent();
    });
  });
});
