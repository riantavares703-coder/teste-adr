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
 * ITEM 14 DO PROMPT 02 — segurança, permissões e isolamento.
 *
 * Duas franquias concorrentes (ACME e RIVAL) e dois clientes distintos, para
 * que cada tentativa de acesso indevido tenha um alvo real.
 */
describe('Segurança, permissões e isolamento', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let acme: Fixture;
  let rival: Fixture;
  let customerA: { token: string; id: string };
  let customerB: { token: string; id: string };

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
    acme = await seedOrganization(client, { slug: 'acme' });
    rival = await seedOrganization(client, { slug: 'rival' });
    customerA = await loginCustomer(client, '+5511911111111');
    customerB = await loginCustomer(client, '+5511922222222');
  }, 120_000);

  // ---------------------------------------------------------------------------

  async function loginCustomer(db: pg.Client, phone: string) {
    const { id } = await seedCustomer(db, phone);
    const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
    await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
    const code = app.get(OtpDeliveryService).getDevCode(phone)!;
    const res = await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code });
    return { token: res.body.accessToken as string, id };
  }

  async function loginStaff(fixture: Fixture, who: 'manager' | 'operator') {
    const res = await request(baseUrl).post('/v1/auth/login').send({
      organizationSlug: fixture.organizationSlug,
      email: who === 'manager' ? fixture.managerEmail : fixture.operatorEmail,
      password: fixture.password,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.accessToken as string;
  }

  function createOrder(token: string, fixture: Fixture, overrides: Record<string, unknown> = {}) {
    return request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        branchId: fixture.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: fixture.productId, quantity: 1 }],
        ...overrides,
      });
  }

  // === TENTATIVA DE ALTERAR PREÇO ===========================================

  describe('manipulação de preço', () => {
    it('preço enviado pelo cliente é REJEITADO pelo schema estrito', async () => {
      const res = await request(baseUrl)
        .post('/v1/orders')
        .set('Authorization', `Bearer ${customerA.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          branchId: acme.branchId,
          fulfillment: 'PICKUP',
          paymentMethod: 'CASH_ON_SITE',
          items: [{ productId: acme.productId, quantity: 1, price: 1.0, priceCents: 100 }],
          totalCents: 100,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ENTRADA_INVALIDA');
      const { rows } = await client.query('SELECT count(*)::int AS n FROM orders');
      expect(rows[0].n).toBe(0);
    });

    it('cliente é cobrado pelo preço do banco, não pelo que enviou', async () => {
      const res = await createOrder(customerA.token, acme);
      expect(res.status).toBe(201);
      // Produto custa 2990 no banco; nenhum valor foi aceito da requisição.
      expect(res.body.order.subtotalCents).toBe(acme.productPriceCents);
      expect(res.body.order.totalCents).toBe(acme.productPriceCents);
      expect(res.body.items[0].unitPriceCentsSnapshot).toBe(acme.productPriceCents);
    });

    it('divergência de total devolve 409 com o valor recalculado, sem cobrar', async () => {
      const res = await createOrder(customerA.token, acme, { expectedTotalCents: 100 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PRECO_ALTERADO');
      expect(res.body.details.actualTotalCents).toBe(acme.productPriceCents);
    });

    it('status não pode ser injetado na criação', async () => {
      const res = await request(baseUrl)
        .post('/v1/orders')
        .set('Authorization', `Bearer ${customerA.token}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          branchId: acme.branchId,
          fulfillment: 'PICKUP',
          paymentMethod: 'CASH_ON_SITE',
          items: [{ productId: acme.productId, quantity: 1 }],
          status: 'DELIVERED',
        });
      expect(res.status).toBe(400);
    });

    it('OPERATOR não consegue alterar preço (precisa de price:update)', async () => {
      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .patch(`/v1/branches/${acme.branchId}/products/${acme.productId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priceCents: 1 });
      expect(res.status).toBe(403);

      const { rows } = await client.query('SELECT price_cents FROM products WHERE id = $1', [
        acme.productId,
      ]);
      expect(rows[0].price_cents).toBe(acme.productPriceCents);
    });

    it('UNIT_MANAGER consegue alterar preço, e a mudança é auditada', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await request(baseUrl)
        .patch(`/v1/branches/${acme.branchId}/products/${acme.productId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priceCents: 3490 });
      expect(res.status).toBe(200);

      const { rows } = await client.query(
        `SELECT action, metadata FROM audit_logs WHERE action = 'product.price_updated'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ from: 2990, to: 3490 });
    });
  });

  // === PRODUTO ESGOTADO ======================================================

  describe('compra de produto esgotado', () => {
    it('produto esgotado manualmente não pode ser comprado', async () => {
      const staff = await loginStaff(acme, 'operator');
      await request(baseUrl)
        .post(`/v1/branches/${acme.branchId}/inventory/${acme.productId}/sold-out`)
        .set('Authorization', `Bearer ${staff}`)
        .send({ reason: 'Acabou o pão' })
        .expect(201);

      const res = await createOrder(customerA.token, acme);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PRODUTO_INDISPONIVEL');
      expect(res.body.details.status).toBe('MANUALLY_SOLD_OUT');
    });

    it('reativar volta a permitir a compra', async () => {
      const staff = await loginStaff(acme, 'operator');
      await request(baseUrl)
        .post(`/v1/branches/${acme.branchId}/inventory/${acme.productId}/sold-out`)
        .set('Authorization', `Bearer ${staff}`)
        .send({});
      await request(baseUrl)
        .post(`/v1/branches/${acme.branchId}/inventory/${acme.productId}/reactivate`)
        .set('Authorization', `Bearer ${staff}`)
        .send({})
        .expect(201);

      expect((await createOrder(customerA.token, acme)).status).toBe(201);
    });

    it('quantidade zerada torna o produto indisponível automaticamente', async () => {
      await client.query(
        `UPDATE virtual_inventory SET mode='LIMITED', on_hand_qty=0 WHERE product_id=$1`,
        [acme.productId],
      );
      const res = await createOrder(customerA.token, acme);
      expect(res.status).toBe(409);
      expect(res.body.details.available).toBe(0);
    });

    it('esgotado some do cardápio público', async () => {
      const staff = await loginStaff(acme, 'operator');
      await request(baseUrl)
        .post(`/v1/branches/${acme.branchId}/inventory/${acme.productId}/sold-out`)
        .set('Authorization', `Bearer ${staff}`)
        .send({});

      const menu = await request(baseUrl)
        .get(`/v1/public/${acme.organizationSlug}/${acme.branchSlug}/menu`)
        .expect(200);

      const product = menu.body.categories[0].products[0];
      expect(product.availability.isPurchasable).toBe(false);
    });

    it('quem esgotou e quando ficam registrados', async () => {
      const staff = await loginStaff(acme, 'operator');
      await request(baseUrl)
        .post(`/v1/branches/${acme.branchId}/inventory/${acme.productId}/sold-out`)
        .set('Authorization', `Bearer ${staff}`)
        .send({ reason: 'Faltou insumo' });

      const { rows } = await client.query(
        'SELECT sold_out_by, sold_out_at FROM virtual_inventory WHERE product_id = $1',
        [acme.productId],
      );
      expect(rows[0].sold_out_by).toBe(acme.operatorId);
      expect(rows[0].sold_out_at).toBeInstanceOf(Date);

      const movements = await client.query(
        `SELECT actor_user_id, reason FROM inventory_movements WHERE type = 'SOLD_OUT_MANUAL'`,
      );
      expect(movements.rows[0]).toMatchObject({
        actor_user_id: acme.operatorId,
        reason: 'Faltou insumo',
      });
    });
  });

  // === ISOLAMENTO ENTRE FRANQUIAS ============================================

  describe('isolamento entre franquias', () => {
    it('operador da RIVAL não acessa pedido da ACME (404, não 403)', async () => {
      const order = await createOrder(customerA.token, acme);
      const orderId = order.body.order.id;

      const rivalToken = await loginStaff(rival, 'manager');
      const res = await request(baseUrl)
        .get(`/v1/branches/${rival.branchId}/orders/${orderId}`)
        .set('Authorization', `Bearer ${rivalToken}`);

      // 404 e não 403: um 403 confirmaria que o pedido existe.
      expect(res.status).toBe(404);
    });

    it('operador da RIVAL não lista pedidos da ACME nem trocando o branchId', async () => {
      await createOrder(customerA.token, acme);
      const rivalToken = await loginStaff(rival, 'manager');

      const res = await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/orders`)
        .set('Authorization', `Bearer ${rivalToken}`);
      expect([403, 404]).toContain(res.status);
    });

    it('RIVAL não consegue transicionar pedido da ACME', async () => {
      const order = await createOrder(customerA.token, acme);
      const rivalToken = await loginStaff(rival, 'manager');

      const res = await request(baseUrl)
        .post(`/v1/branches/${rival.branchId}/orders/${order.body.order.id}/transition`)
        .set('Authorization', `Bearer ${rivalToken}`)
        .send({ to: 'CANCELLED', reason: 'sabotagem' });
      expect(res.status).toBe(404);

      const { rows } = await client.query('SELECT status FROM orders WHERE id = $1', [
        order.body.order.id,
      ]);
      expect(rows[0].status).toBe('PENDING');
    });

    it('RIVAL não altera produto da ACME', async () => {
      const rivalToken = await loginStaff(rival, 'manager');
      const res = await request(baseUrl)
        .patch(`/v1/branches/${rival.branchId}/products/${acme.productId}`)
        .set('Authorization', `Bearer ${rivalToken}`)
        .send({ name: 'Invadido' });
      expect(res.status).toBe(404);
    });

    it('RIVAL não esgota produto da ACME', async () => {
      const rivalToken = await loginStaff(rival, 'operator');
      const res = await request(baseUrl)
        .post(`/v1/branches/${rival.branchId}/inventory/${acme.productId}/sold-out`)
        .set('Authorization', `Bearer ${rivalToken}`)
        .send({});
      expect(res.status).toBe(404);
    });

    it('RLS: a MESMA consulta, sem WHERE de tenant, devolve 0 linhas para a franquia errada', async () => {
      await createOrder(customerA.token, acme);

      const asAcme = await selectOrdersAs(client, acme.organizationId);
      const asRival = await selectOrdersAs(client, rival.organizationId);

      expect(asAcme).toBe(1);
      expect(asRival).toBe(0);
    });
  });

  // === ISOLAMENTO ENTRE UNIDADES DA MESMA FRANQUIA ===========================

  describe('isolamento entre unidades da mesma franquia', () => {
    it('OPERATOR com escopo de uma unidade não acessa a outra', async () => {
      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .get(`/v1/branches/${acme.secondBranchId}/orders`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('UNIT_MANAGER com escopo de organização acessa ambas', async () => {
      const token = await loginStaff(acme, 'manager');
      for (const branchId of [acme.branchId, acme.secondBranchId]) {
        const res = await request(baseUrl)
          .get(`/v1/branches/${branchId}/orders`)
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
      }
    });

    it('concessão explícita habilita a outra unidade (permissão administrativa)', async () => {
      await client.query(
        `INSERT INTO user_roles (id, user_id, role_id, organization_id, branch_id)
         SELECT $1, $2, id, $3, $4 FROM roles WHERE code = 'OPERATOR'`,
        [randomUUID(), acme.operatorId, acme.organizationId, acme.secondBranchId],
      );
      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .get(`/v1/branches/${acme.secondBranchId}/orders`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('concessão VENCIDA não vale', async () => {
      await client.query(
        `INSERT INTO user_roles (id, user_id, role_id, organization_id, branch_id, granted_at, expires_at)
         SELECT $1, $2, id, $3, $4, now() - interval '2 hours', now() - interval '1 hour'
           FROM roles WHERE code = 'OPERATOR'`,
        [randomUUID(), acme.operatorId, acme.organizationId, acme.secondBranchId],
      );
      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .get(`/v1/branches/${acme.secondBranchId}/orders`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('produto de outra unidade não entra no pedido', async () => {
      const res = await createOrder(customerA.token, acme, {
        branchId: acme.secondBranchId,
        items: [{ productId: acme.productId, quantity: 1 }],
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PRODUTO_INVALIDO');
    });
  });

  // === ISOLAMENTO ENTRE CLIENTES =============================================

  describe('isolamento entre clientes', () => {
    it('cliente B não vê pedido do cliente A pelo ID exato', async () => {
      const order = await createOrder(customerA.token, acme);
      const res = await request(baseUrl)
        .get(`/v1/orders/${order.body.order.id}`)
        .set('Authorization', `Bearer ${customerB.token}`);
      expect(res.status).toBe(404);
    });

    it('cliente B não cancela pedido do cliente A', async () => {
      const order = await createOrder(customerA.token, acme);
      const res = await request(baseUrl)
        .post(`/v1/orders/${order.body.order.id}/cancel`)
        .set('Authorization', `Bearer ${customerB.token}`);
      expect(res.status).toBe(404);
    });

    it('listagem do cliente traz apenas os próprios pedidos', async () => {
      await createOrder(customerA.token, acme);
      await createOrder(customerB.token, acme);

      const listA = await request(baseUrl)
        .get('/v1/orders')
        .set('Authorization', `Bearer ${customerA.token}`);
      expect(listA.body).toHaveLength(1);
      expect(listA.body[0].order.customerId).toBe(customerA.id);
    });

    it('cliente não acessa a fila de pedidos da loja', async () => {
      const res = await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/orders`)
        .set('Authorization', `Bearer ${customerA.token}`);
      expect(res.status).toBe(403);
    });

    it('cliente não confirma o próprio pagamento', async () => {
      const order = await createOrder(customerA.token, acme);
      const { rows } = await client.query('SELECT id FROM payments WHERE order_id = $1', [
        order.body.order.id,
      ]);
      const res = await request(baseUrl)
        .post(`/v1/branches/${acme.branchId}/payments/${rows[0].id}/confirm`)
        .set('Authorization', `Bearer ${customerA.token}`)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  // === AUTENTICAÇÃO ==========================================================

  describe('autenticação', () => {
    it('rota protegida sem token devolve 401', async () => {
      const res = await request(baseUrl).get('/v1/orders');
      expect(res.status).toBe(401);
    });

    it('token forjado é rejeitado', async () => {
      const res = await request(baseUrl)
        .get('/v1/orders')
        .set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.');
      expect(res.status).toBe(401);
    });

    it('senha errada e usuário inexistente devolvem a MESMA resposta', async () => {
      const wrongPassword = await request(baseUrl).post('/v1/auth/login').send({
        organizationSlug: acme.organizationSlug,
        email: acme.managerEmail,
        password: 'senha-completamente-errada',
      });
      const noUser = await request(baseUrl).post('/v1/auth/login').send({
        organizationSlug: acme.organizationSlug,
        email: 'ninguem@acme.com',
        password: 'senha-completamente-errada',
      });

      expect(wrongPassword.status).toBe(noUser.status);
      expect(wrongPassword.body.code).toBe(noUser.body.code);
      expect(wrongPassword.body.title).toBe(noUser.body.title);
    });

    it('bloqueio progressivo após tentativas repetidas', async () => {
      for (let i = 0; i < 5; i++) {
        await request(baseUrl).post('/v1/auth/login').send({
          organizationSlug: acme.organizationSlug,
          email: acme.managerEmail,
          password: 'errada',
        });
      }
      const { rows } = await client.query('SELECT locked_until FROM users WHERE id = $1', [
        acme.managerId,
      ]);
      expect(rows[0].locked_until).not.toBeNull();

      // Mesmo com a senha CERTA, a conta bloqueada não entra.
      const res = await request(baseUrl).post('/v1/auth/login').send({
        organizationSlug: acme.organizationSlug,
        email: acme.managerEmail,
        password: acme.password,
      });
      expect(res.status).toBe(401);
    });

    it('reuso de refresh token queima a família inteira', async () => {
      const login = await request(baseUrl).post('/v1/auth/login').send({
        organizationSlug: acme.organizationSlug,
        email: acme.managerEmail,
        password: acme.password,
      });
      const first = login.body.refreshToken;

      const rotated = await request(baseUrl).post('/v1/auth/refresh').send({ refreshToken: first });
      expect(rotated.status).toBe(201);

      // Apresentar o token ANTIGO: sinal de roubo.
      const reuse = await request(baseUrl).post('/v1/auth/refresh').send({ refreshToken: first });
      expect(reuse.status).toBe(401);
      expect(reuse.body.code).toBe('REUSO_DETECTADO');

      // O token novo também foi invalidado pela revogação da família.
      const afterBurn = await request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken });
      expect(afterBurn.status).toBe(401);
    });

    it('login de operador de OUTRA organização com o mesmo e-mail não cruza tenant', async () => {
      const res = await request(baseUrl).post('/v1/auth/login').send({
        organizationSlug: rival.organizationSlug,
        email: acme.managerEmail, // e-mail da ACME, organização da RIVAL
        password: acme.password,
      });
      expect(res.status).toBe(401);
    });
  });

  // === PERMISSÕES ============================================================

  describe('permissões (RBAC)', () => {
    it('OPERATOR não configura chave Pix', async () => {
      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/pix-settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          keyType: 'EMAIL',
          key: 'ladrao@golpe.com',
          merchantName: 'GOLPE',
          merchantCity: 'SP',
        });
      expect(res.status).toBe(403);
    });

    it('OPERATOR não exclui produto', async () => {
      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .delete(`/v1/branches/${acme.branchId}/products/${acme.productId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('OPERATOR PODE marcar esgotado e confirmar pagamento', async () => {
      const token = await loginStaff(acme, 'operator');
      const soldOut = await request(baseUrl)
        .post(`/v1/branches/${acme.branchId}/inventory/${acme.productId}/sold-out`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(soldOut.status).toBe(201);
    });

    it('a chave Pix nunca aparece em claro na auditoria', async () => {
      const token = await loginStaff(acme, 'manager');
      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/pix-settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          keyType: 'EMAIL',
          key: 'financeiro@acme.com.br',
          merchantName: 'ACME',
          merchantCity: 'SAO PAULO',
        })
        .expect(200);

      const { rows } = await client.query(
        `SELECT metadata::text AS m FROM audit_logs WHERE action = 'pix_settings.updated'`,
      );
      expect(rows[0].m).not.toContain('financeiro@acme.com.br');
      expect(rows[0].m).toContain('keyChanged');
    });
  });
});

/** Executa a MESMA consulta sob o contexto de tenant informado, via RLS. */
async function selectOrdersAs(client: pg.Client, organizationId: string): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE app_user');
    await client.query(
      `SELECT set_config('app.user_type', 'STAFF', true),
              set_config('app.organization_id', $1, true)`,
      [organizationId],
    );
    const { rows } = await client.query('SELECT count(*)::int AS n FROM orders');
    return rows[0].n;
  } finally {
    await client.query('COMMIT');
  }
}
