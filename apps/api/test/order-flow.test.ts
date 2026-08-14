import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { uuidv7 } from '../src/common/uuid.js';

/** Itens 5, 6, 7, 8 e 10 do Prompt 02: carrinho, checkout, pagamento, pedido, status. */
describe('Fluxo de pedido ponta a ponta', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let f: Fixture;
  let customer: { token: string; id: string };

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
    customer = await loginCustomer('+5511933333333');
  }, 120_000);

  async function loginCustomer(phone: string) {
    const { id } = await seedCustomer(client, phone);
    const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
    await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
    const code = app.get(OtpDeliveryService).getDevCode(phone)!;
    const res = await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code });
    return { token: res.body.accessToken as string, id };
  }

  async function staffToken(who: 'manager' | 'operator' = 'operator') {
    const res = await request(baseUrl).post('/v1/auth/login').send({
      organizationSlug: f.organizationSlug,
      email: who === 'manager' ? f.managerEmail : f.operatorEmail,
      password: f.password,
    });
    return res.body.accessToken as string;
  }

  function order(body: Record<string, unknown>) {
    return request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

  async function addAddress(postalCode = '01310100') {
    const id = uuidv7();
    await client.query(
      `INSERT INTO delivery_addresses (id, customer_id, postal_code, street, street_number, district, city, state_code)
       VALUES ($1, $2, $3, 'Av. Paulista', '1000', 'Bela Vista', 'São Paulo', 'SP')`,
      [id, customer.id, postalCode],
    );
    return id;
  }

  // === CARRINHO E CÁLCULO ====================================================

  describe('carrinho e cálculo (item 5)', () => {
    it('subtotal reflete quantidade x preço do banco', async () => {
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 3 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.order.subtotalCents).toBe(2990 * 3);
      expect(res.body.items[0].lineTotalCents).toBe(2990 * 3);
    });

    it('adicionais entram no preço, validados contra o produto', async () => {
      const groupId = uuidv7();
      const optionId = uuidv7();
      await client.query(
        `INSERT INTO modifier_groups (id, organization_id, branch_id, name, max_select)
         VALUES ($1, $2, $3, 'Adicionais', 3)`,
        [groupId, f.organizationId, f.branchId],
      );
      await client.query(
        `INSERT INTO modifier_options (id, modifier_group_id, branch_id, name, price_delta_cents)
         VALUES ($1, $2, $3, 'Bacon', 500)`,
        [optionId, groupId, f.branchId],
      );
      await client.query(
        `INSERT INTO product_modifier_groups (product_id, modifier_group_id, branch_id)
         VALUES ($1, $2, $3)`,
        [f.productId, groupId, f.branchId],
      );

      const res = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 2, optionIds: [optionId] }],
      });
      expect(res.status).toBe(201);
      // (2990 + 500) x 2
      expect(res.body.order.subtotalCents).toBe(6980);
    });

    it('adicional de outro produto é recusado', async () => {
      const groupId = uuidv7();
      const optionId = uuidv7();
      await client.query(
        `INSERT INTO modifier_groups (id, organization_id, branch_id, name) VALUES ($1,$2,$3,'Solto')`,
        [groupId, f.organizationId, f.branchId],
      );
      await client.query(
        `INSERT INTO modifier_options (id, modifier_group_id, branch_id, name, price_delta_cents)
         VALUES ($1,$2,$3,'Órfão', -2900)`,
        [optionId, groupId, f.branchId],
      );
      // Sem vínculo product_modifier_groups: não pertence ao produto.
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1, optionIds: [optionId] }],
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OPCAO_INVALIDA');
    });

    it('taxa de entrega vem da zona configurada, não do cliente', async () => {
      const addressId = await addAddress();
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'DELIVERY',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
        deliveryAddressId: addressId,
      });
      expect(res.status).toBe(201);
      expect(res.body.order.deliveryFeeCents).toBe(700);
      expect(res.body.order.totalCents).toBe(2990 + 700);
    });

    it('endereço fora da área de entrega é recusado', async () => {
      const addressId = await addAddress('99999999');
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'DELIVERY',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
        deliveryAddressId: addressId,
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('FORA_DA_AREA');
    });

    it('pedido abaixo do mínimo da unidade é recusado', async () => {
      await client.query('UPDATE store_settings SET min_order_cents = 5000 WHERE branch_id = $1', [
        f.branchId,
      ]);
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PEDIDO_MINIMO');
    });
  });

  // === CHECKOUT ==============================================================

  describe('checkout (item 6)', () => {
    it('ENTREGA exige endereço', async () => {
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'DELIVERY',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ENDERECO_OBRIGATORIO');
    });

    it('RETIRADA não exige endereço e não cobra taxa', async () => {
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.order.deliveryFeeCents).toBe(0);
    });

    it('endereço de outro cliente devolve 404', async () => {
      const other = await loginCustomer('+5511944444444');
      const addressId = uuidv7();
      await client.query(
        `INSERT INTO delivery_addresses (id, customer_id, postal_code, street, street_number, district, city, state_code)
         VALUES ($1,$2,'01310100','Rua','1','Centro','São Paulo','SP')`,
        [addressId, other.id],
      );
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'DELIVERY',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
        deliveryAddressId: addressId,
      });
      expect(res.status).toBe(404);
    });

    it('método de pagamento não habilitado é recusado', async () => {
      await client.query(
        `UPDATE store_settings SET enabled_payment_methods = ARRAY['PIX']::payment_method[] WHERE branch_id = $1`,
        [f.branchId],
      );
      const res = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('METODO_INDISPONIVEL');
    });

    it('Idempotency-Key é obrigatória e evita pedido duplicado', async () => {
      const semChave = await request(baseUrl)
        .post('/v1/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({
          branchId: f.branchId,
          fulfillment: 'PICKUP',
          paymentMethod: 'CASH_ON_SITE',
          items: [{ productId: f.productId, quantity: 1 }],
        });
      expect(semChave.status).toBe(400);

      const key = randomUUID();
      const body = {
        branchId: f.branchId,
        fulfillment: 'PICKUP' as const,
        paymentMethod: 'CASH_ON_SITE' as const,
        items: [{ productId: f.productId, quantity: 1 }],
      };
      const send = () =>
        request(baseUrl)
          .post('/v1/orders')
          .set('Authorization', `Bearer ${customer.token}`)
          .set('Idempotency-Key', key)
          .send(body);

      const first = await send();
      const second = await send();
      expect(first.status).toBe(201);
      expect(second.body.order.id).toBe(first.body.order.id);
      expect(second.body.replayed).toBe(true);

      const { rows } = await client.query('SELECT count(*)::int AS n FROM orders');
      expect(rows[0].n).toBe(1);
    });

    it('mesma chave com corpo diferente é conflito, não repetição', async () => {
      const key = randomUUID();
      await request(baseUrl)
        .post('/v1/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .set('Idempotency-Key', key)
        .send({
          branchId: f.branchId,
          fulfillment: 'PICKUP',
          paymentMethod: 'CASH_ON_SITE',
          items: [{ productId: f.productId, quantity: 1 }],
        });

      const res = await request(baseUrl)
        .post('/v1/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .set('Idempotency-Key', key)
        .send({
          branchId: f.branchId,
          fulfillment: 'PICKUP',
          paymentMethod: 'CASH_ON_SITE',
          items: [{ productId: f.productId, quantity: 9 }],
        });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CHAVE_IDEMPOTENCIA_REUTILIZADA');
    });
  });

  // === PAGAMENTO =============================================================

  describe('pagamento (item 7)', () => {
    it('as duas máquinas de estado são independentes', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      const orderId = created.body.order.id;
      const token = await staffToken();

      // Pedido avança até EM PREPARAÇÃO com pagamento ainda PENDENTE.
      await transition(token, orderId, 'CONFIRMED');
      await transition(token, orderId, 'PREPARING');

      const { rows } = await client.query(
        `SELECT o.status AS order_status, p.status AS payment_status
           FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
        [orderId],
      );
      expect(rows[0].order_status).toBe('PREPARING');
      expect(rows[0].payment_status).toBe('PENDING');
    });

    it('Pix gera BR Code válido com o valor do pedido embutido', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 2 }],
      });
      expect(created.status).toBe(201);

      const payment = await request(baseUrl)
        .get(`/v1/orders/${created.body.order.id}/payment`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      expect(payment.body.status).toBe('AWAITING_CONFIRMATION');
      expect(payment.body.amountCents).toBe(5980);
      expect(validateBrCodeChecksum(payment.body.pixBrcode)).toBe(true);
      expect(parseEmv(payment.body.pixBrcode)['54']).toBe('59.80');

      // Chave exibida mascarada; nunca completa fora do necessário.
      expect(payment.body.pixKeyMasked).toMatch(/^•••/);
      // Comunicação honesta: nenhum provedor confirma sozinho.
      expect(payment.body.automaticConfirmation).toBe(false);
    });

    it('chave Pix de demonstração NUNCA gera cobrança — cliente real não pode receber QR de chave inexistente', async () => {
      await client.query('UPDATE pix_settings SET is_demo_seed = true WHERE branch_id = $1', [
        f.branchId,
      ]);

      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      expect(created.status).toBe(422);
      expect(created.body.code).toBe('PIX_NAO_CONFIGURADO');

      const token = await staffToken('manager');
      const settings = await request(baseUrl)
        .get(`/v1/branches/${f.branchId}/pix-settings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // Mesmo com uma linha existindo no banco, o operador vê "não configurado"
      // — é o sinal correto para ele agir e cadastrar a chave de verdade.
      expect(settings.body.configured).toBe(false);
    });

    it('salvar a chave de verdade substitui a de demonstração e volta a permitir Pix', async () => {
      await client.query('UPDATE pix_settings SET is_demo_seed = true WHERE branch_id = $1', [
        f.branchId,
      ]);
      const token = await staffToken('manager');

      await request(baseUrl)
        .put(`/v1/branches/${f.branchId}/pix-settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ keyType: 'EMAIL', key: 'dono@restaurante.com.br', merchantName: 'Loja', merchantCity: 'SAO PAULO' })
        .expect(200);

      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      expect(created.status).toBe(201);

      const payment = await request(baseUrl)
        .get(`/v1/orders/${created.body.order.id}/payment`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
      expect(validateBrCodeChecksum(payment.body.pixBrcode)).toBe(true);
    });

    it('Pix não confirmado NÃO deixa o pedido ser confirmado', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      const token = await staffToken();
      const res = await transition(token, created.body.order.id, 'CONFIRMED');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PAYMENT_NOT_CONFIRMED');
    });

    it('confirmação manual registra ator, horário e é auditada', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      const { rows } = await client.query('SELECT id FROM payments WHERE order_id = $1', [
        created.body.order.id,
      ]);
      const token = await staffToken();

      const res = await request(baseUrl)
        .post(`/v1/branches/${f.branchId}/payments/${rows[0].id}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 'Recebido no app do banco' });
      expect(res.status).toBe(201);
      expect(res.body.paymentStatus).toBe('CONFIRMED');
      // Confirmar pagamento NÃO avança o pedido sozinho.
      expect(res.body.orderStatus).toBe('PENDING');

      const payment = await client.query(
        'SELECT confirmed_by, confirmed_at FROM payments WHERE id = $1',
        [rows[0].id],
      );
      expect(payment.rows[0].confirmed_by).toBe(f.operatorId);
      expect(payment.rows[0].confirmed_at).toBeInstanceOf(Date);

      const audit = await client.query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'payment.confirmed_manually'`,
      );
      expect(audit.rows[0].n).toBe(1);
    });

    it('confirmar duas vezes é conflito', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      const { rows } = await client.query('SELECT id FROM payments WHERE order_id = $1', [
        created.body.order.id,
      ]);
      const token = await staffToken();
      const confirm = () =>
        request(baseUrl)
          .post(`/v1/branches/${f.branchId}/payments/${rows[0].id}/confirm`)
          .set('Authorization', `Bearer ${token}`)
          .send({});
      await confirm();
      const second = await confirm();
      expect(second.status).toBe(409);
    });
  });

  // === STATUS ================================================================

  describe('mudança de status (item 10)', () => {
    function transitionReq(token: string, orderId: string, to: string, reason?: string) {
      return request(baseUrl)
        .post(`/v1/branches/${f.branchId}/orders/${orderId}/transition`)
        .set('Authorization', `Bearer ${token}`)
        .send(reason ? { to, reason } : { to });
    }

    it('fluxo de RETIRADA completo', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      const id = created.body.order.id;
      const token = await staffToken();

      for (const to of ['CONFIRMED', 'PREPARING', 'READY', 'AWAITING_PICKUP', 'PICKED_UP']) {
        const res = await transitionReq(token, id, to);
        expect(res.status, `${to}: ${JSON.stringify(res.body)}`).toBe(201);
      }

      const history = await client.query(
        'SELECT to_status FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id',
        [id],
      );
      expect(history.rows.map((r) => r.to_status)).toEqual([
        'PENDING',
        'CONFIRMED',
        'PREPARING',
        'READY',
        'AWAITING_PICKUP',
        'PICKED_UP',
      ]);
    });

    it('fluxo de ENTREGA completo', async () => {
      const addressId = await addAddress();
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'DELIVERY',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
        deliveryAddressId: addressId,
      });
      const id = created.body.order.id;
      const token = await staffToken();

      for (const to of ['CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
        expect((await transitionReq(token, id, to)).status).toBe(201);
      }
    });

    it('pulo de etapa é recusado', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      const token = await staffToken();
      const res = await transitionReq(token, created.body.order.id, 'READY');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
    });

    it('retirada não vai para EM ROTA', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      const id = created.body.order.id;
      const token = await staffToken();
      await transitionReq(token, id, 'CONFIRMED');
      await transitionReq(token, id, 'PREPARING');
      await transitionReq(token, id, 'READY');
      const res = await transitionReq(token, id, 'OUT_FOR_DELIVERY');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WRONG_FULFILLMENT');
    });

    it('estado terminal não transiciona', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      const id = created.body.order.id;
      const token = await staffToken();
      await transitionReq(token, id, 'CANCELLED', 'desistiu');
      const res = await transitionReq(token, id, 'CONFIRMED');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TERMINAL_STATE');
    });

    it('histórico é imutável', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      await expect(
        client.query(`UPDATE order_status_history SET to_status = 'DELIVERED' WHERE order_id = $1`, [
          created.body.order.id,
        ]),
      ).rejects.toThrow(/append-only/);
    });
  });

  // === ESTOQUE NO CICLO DE VIDA ==============================================

  describe('estoque ao longo do ciclo', () => {
    beforeEach(async () => {
      await client.query(
        `UPDATE virtual_inventory SET mode='LIMITED', on_hand_qty=10, reserved_qty=0 WHERE product_id=$1`,
        [f.productId],
      );
    });

    async function stock() {
      const { rows } = await client.query(
        'SELECT on_hand_qty, reserved_qty FROM virtual_inventory WHERE product_id = $1',
        [f.productId],
      );
      return { onHand: rows[0].on_hand_qty, reserved: rows[0].reserved_qty };
    }

    it('criar reserva; confirmar consome; 20 -> 19 do exemplo do briefing', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 1 }],
      });
      expect(await stock()).toEqual({ onHand: 10, reserved: 1 });

      const token = await staffToken();
      await transition(token, created.body.order.id, 'CONFIRMED');
      expect(await stock()).toEqual({ onHand: 9, reserved: 0 });
    });

    it('cancelar antes de confirmar devolve a reserva', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 3 }],
      });
      expect((await stock()).reserved).toBe(3);

      await request(baseUrl)
        .post(`/v1/orders/${created.body.order.id}/cancel`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(201);

      expect(await stock()).toEqual({ onHand: 10, reserved: 0 });
    });

    it('expiração da janela de Pix devolve o estoque', async () => {
      const created = await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'PIX',
        items: [{ productId: f.productId, quantity: 2 }],
      });
      expect((await stock()).reserved).toBe(2);

      // Simula o vencimento da janela.
      await client.query(
        `UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [created.body.order.id],
      );

      const { OrderingService } = await import('../src/modules/ordering/ordering.service.js');
      const expired = await app.get(OrderingService).expireStaleOrders();
      expect(expired).toBe(1);

      expect(await stock()).toEqual({ onHand: 10, reserved: 0 });
      const { rows } = await client.query('SELECT status FROM orders WHERE id = $1', [
        created.body.order.id,
      ]);
      expect(rows[0].status).toBe('EXPIRED');
    });

    it('[ +1 ] [ +5 ] [ +10 ] ajustam a quantidade', async () => {
      const token = await staffToken();
      for (const delta of [1, 5, 10]) {
        const res = await request(baseUrl)
          .post(`/v1/branches/${f.branchId}/inventory/${f.productId}/adjust`)
          .set('Authorization', `Bearer ${token}`)
          .send({ delta });
        expect(res.status).toBe(201);
      }
      expect((await stock()).onHand).toBe(26);
    });

    it('ajuste que deixaria o estoque abaixo do reservado é recusado', async () => {
      await order({
        branchId: f.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: f.productId, quantity: 8 }],
      });
      const token = await staffToken();
      const res = await request(baseUrl)
        .post(`/v1/branches/${f.branchId}/inventory/${f.productId}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ delta: -5, reason: 'quebra' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AJUSTE_ABAIXO_DO_RESERVADO');
    });

    it('painel de estoque mostra Produto | Disponível | Status', async () => {
      const token = await staffToken();
      const res = await request(baseUrl)
        .get(`/v1/branches/${f.branchId}/inventory`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body[0]).toMatchObject({
        productName: 'X-Burger',
        onHandQty: 10,
        availability: { status: 'AVAILABLE', availableQuantity: 10, isPurchasable: true },
      });
    });
  });

  async function transition(token: string, orderId: string, to: string) {
    return request(baseUrl)
      .post(`/v1/branches/${f.branchId}/orders/${orderId}/transition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ to });
  }
});
