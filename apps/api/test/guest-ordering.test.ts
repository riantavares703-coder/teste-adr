import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  TEST_DATABASE_URL,
  createTestApp,
  resetAll,
  seedOrganization,
  setupDatabase,
  type Fixture,
} from './helpers/harness.js';

/**
 * PEDIDO DE BALCÃO — cliente que chegou pelo QR code, sem conta.
 *
 * A sessão de convidado é a única rota pública que EMITE credencial sem provar
 * posse do identificador. Este arquivo existe para que essa concessão fique
 * cercada: o que ela permite, e principalmente o que ela continua NÃO
 * permitindo.
 */
describe('Pedido de balcão (cliente convidado)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let loja: Fixture;

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
    loja = await seedOrganization(client, { slug: 'lanchonete' });
  });

  async function guest(phone: string, fullName = 'Cliente Balcão') {
    const response = await request(baseUrl)
      .post('/v1/auth/guest')
      .send({ phone, fullName })
      .expect(201);
    return response.body.accessToken as string;
  }

  /** Sem `async`: devolve a cadeia do supertest para poder encadear `.expect`. */
  function placeOrder(token: string, key: string) {
    return request(baseUrl)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({
        branchId: loja.branchId,
        fulfillment: 'PICKUP',
        paymentMethod: 'CASH_ON_SITE',
        items: [{ productId: loja.productId, quantity: 1 }],
      });
  }

  it('emite sessão com nome e telefone, sem código de verificação', async () => {
    const token = await guest('+5511900000001');
    expect(token).toBeTruthy();

    const me = await request(baseUrl)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(me.body.userType).toBe('CUSTOMER');
    expect(me.body.permissions).toContain('order:create');
  });

  it('marca o telefone como NÃO verificado', async () => {
    await guest('+5511900000002');
    const { rows } = await client.query(
      'SELECT phone_verified_at FROM users WHERE phone_e164 = $1',
      ['+5511900000002'],
    );
    // O banco precisa registrar que este número não foi provado — é o que
    // permite tratar o convidado diferente de um cliente verificado depois.
    expect(rows[0].phone_verified_at).toBeNull();
  });

  it('o convidado consegue fazer e acompanhar o próprio pedido', async () => {
    const token = await guest('+5511900000003');
    const created = await placeOrder(token, '33333333-3333-4333-8333-333333333333').expect(201);

    const orderId = created.body.order.id;
    const detail = await request(baseUrl)
      .get(`/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detail.body.order.id).toBe(orderId);
    expect(detail.body.order.status).toBe('PENDING');
  });

  it('um convidado NÃO vê o pedido de outro, nem pelo ID exato', async () => {
    const ana = await guest('+5511900000004', 'Ana');
    const created = await placeOrder(ana, '44444444-4444-4444-8444-444444444444').expect(201);

    const joao = await guest('+5511900000005', 'João');
    await request(baseUrl)
      .get(`/v1/orders/${created.body.order.id}`)
      .set('Authorization', `Bearer ${joao}`)
      .expect(404);

    const lista = await request(baseUrl)
      .get('/v1/orders')
      .set('Authorization', `Bearer ${joao}`)
      .expect(200);
    expect(lista.body).toEqual([]);
  });

  it('NÃO assume uma conta cujo telefone já foi verificado', async () => {
    // Cenário que só existe depois de configurar um provedor de OTP real: sem
    // esta recusa, bastaria saber o número de um cliente para ler o histórico
    // dele digitando-o na tela de pedido.
    const phone = '+5511900000006';
    await guest(phone, 'Dono do número');
    await client.query('UPDATE users SET phone_verified_at = now() WHERE phone_e164 = $1', [phone]);

    await request(baseUrl)
      .post('/v1/auth/guest')
      .send({ phone, fullName: 'Impostor' })
      .expect(403);
  });

  it('exige nome — o operador precisa saber quem chamar', async () => {
    await request(baseUrl)
      .post('/v1/auth/guest')
      .send({ phone: '+5511900000007', fullName: 'A' })
      // 400: o corpo é recusado pelo schema antes de chegar ao serviço.
      .expect(400);
  });

  it('recusa telefone fora do formato E.164', async () => {
    await request(baseUrl)
      .post('/v1/auth/guest')
      .send({ phone: '11987654321', fullName: 'Sem código do país' })
      .expect(400);
  });

  it('reaproveita o mesmo cliente quando o telefone se repete', async () => {
    await guest('+5511900000008', 'Primeiro Nome');
    await guest('+5511900000008', 'Nome Corrigido');

    const { rows } = await client.query(
      'SELECT full_name FROM users WHERE phone_e164 = $1',
      ['+5511900000008'],
    );
    expect(rows).toHaveLength(1);
    // Quem está pedindo agora é quem dá nome ao pedido de agora.
    expect(rows[0].full_name).toBe('Nome Corrigido');
  });

  it('o operador da loja enxerga o pedido do convidado na fila', async () => {
    const token = await guest('+5511900000009', 'Cliente da Fila');
    await placeOrder(token, '99999999-9999-4999-8999-999999999999').expect(201);

    const login = await request(baseUrl)
      .post('/v1/auth/login')
      .send({
        organizationSlug: loja.organizationSlug,
        email: loja.managerEmail,
        password: loja.password,
      })
      .expect(201);

    const fila = await request(baseUrl)
      .get(`/v1/branches/${loja.branchId}/orders`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);

    expect(fila.body).toHaveLength(1);
    expect(fila.body[0].order.status).toBe('PENDING');
  });

  it('o convidado NÃO ganha poder de operação com a sessão que recebeu', async () => {
    const token = await guest('+5511900000010');
    const created = await placeOrder(token, '10101010-1010-4010-8010-101010101010').expect(201);

    // Sessão de cliente não move pedido na fila, mesmo sendo o pedido dele.
    await request(baseUrl)
      .post(`/v1/branches/${loja.branchId}/orders/${created.body.order.id}/transition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ to: 'CONFIRMED' })
      .expect(403);

    // Nem enxerga a fila da loja.
    await request(baseUrl)
      .get(`/v1/branches/${loja.branchId}/orders`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
