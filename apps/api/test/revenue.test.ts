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
 * FATURAMENTO AO LONGO DO TEMPO.
 *
 * O total sozinho não decide nada: R$ 400 no mês só significa alguma coisa
 * comparado ao mês anterior. Estes testes cobrem a série, a comparação e —
 * principalmente — que a comparação continua sujeita ao mesmo isolamento por
 * franquia do resto do sistema.
 */
describe('Faturamento por período', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let acme: Fixture;
  let rival: Fixture;
  let gerente: string;

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

    const login = await request(baseUrl)
      .post('/v1/auth/login')
      .send({
        organizationSlug: acme.organizationSlug,
        email: acme.managerEmail,
        password: acme.password,
      })
      .expect(201);
    gerente = login.body.accessToken;
  });

  /**
   * Grava um pedido CONCLUÍDO com data escolhida.
   *
   * Direto no banco de propósito: passar pelo checkout não permitiria datar o
   * pedido no passado, e o que está sob teste é a agregação por período.
   */
  async function venda(
    fixture: Fixture,
    diasAtras: number,
    totalCents: number,
    branchId = fixture.branchId,
  ) {
    const id = randomUUID();
    const quando = new Date(Date.now() - diasAtras * 24 * 60 * 60 * 1000);
    const cliente = await seedCustomer(
      client,
      `+55119${Math.floor(Math.random() * 100_000_000)}`,
    );
    await client.query(
      `INSERT INTO orders (id, organization_id, branch_id, customer_id, order_number, business_date,
                           status, fulfillment, payment_method, subtotal_cents, delivery_fee_cents,
                           discount_cents, total_cents, placed_at)
       VALUES ($1,$2,$3,$4,$5,$7::date,'DELIVERED','PICKUP','CASH_ON_SITE',$6,0,0,$6,$7)`,
      [
        id,
        fixture.organizationId,
        branchId,
        cliente.id,
        `T${Math.floor(Math.random() * 1_000_000)}`,
        totalCents,
        quando,
      ],
    );
    return id;
  }

  function buscar(token: string, days: number) {
    return request(baseUrl)
      .get(`/v1/analytics/revenue?days=${days}`)
      .set('Authorization', `Bearer ${token}`);
  }

  it('soma apenas o período pedido', async () => {
    await venda(acme, 2, 5000);
    await venda(acme, 3, 3000);
    await venda(acme, 40, 999_999); // fora da janela de 7 dias

    const response = await buscar(gerente, 7).expect(200);
    expect(response.body.current.revenueCents).toBe(8000);
    expect(response.body.current.orderCount).toBe(2);
  });

  it('compara com o período anterior de MESMA duração', async () => {
    await venda(acme, 2, 10_000); // dentro dos 7 dias
    await venda(acme, 9, 5000); // dentro dos 7 dias anteriores

    const response = await buscar(gerente, 7).expect(200);
    expect(response.body.current.revenueCents).toBe(10_000);
    expect(response.body.previous.revenueCents).toBe(5000);
    // Dobrou.
    expect(response.body.change.revenuePercent).toBe(100);
  });

  it('aponta queda com percentual negativo', async () => {
    await venda(acme, 2, 4000);
    await venda(acme, 9, 10_000);

    const response = await buscar(gerente, 7).expect(200);
    expect(response.body.change.revenuePercent).toBe(-60);
  });

  it('sem movimento antes, devolve null em vez de um percentual inventado', async () => {
    await venda(acme, 2, 4000);

    const response = await buscar(gerente, 7).expect(200);
    expect(response.body.previous.revenueCents).toBe(0);
    // "Cresceu 100% a partir de zero" não informa nada; a tela precisa poder
    // dizer "sem base de comparação".
    expect(response.body.change.revenuePercent).toBeNull();
  });

  it('devolve a série agrupada por dia em janelas curtas', async () => {
    await venda(acme, 1, 1000);
    await venda(acme, 1, 2000);
    await venda(acme, 3, 4000);

    const response = await buscar(gerente, 7).expect(200);
    expect(response.body.bucket).toBe('day');
    expect(response.body.series).toHaveLength(2);
    // Dois pedidos do mesmo dia entram no mesmo ponto.
    const total = response.body.series.reduce(
      (sum: number, point: { revenueCents: number }) => sum + point.revenueCents,
      0,
    );
    expect(total).toBe(7000);
  });

  it('agrupa por semana e por mês em janelas longas', async () => {
    await venda(acme, 10, 1000);
    expect((await buscar(gerente, 90).expect(200)).body.bucket).toBe('week');
    expect((await buscar(gerente, 365).expect(200)).body.bucket).toBe('month');
  });

  it('conta apenas venda concluída, não pedido cancelado', async () => {
    await venda(acme, 1, 5000);
    const cliente = await seedCustomer(client, '+5511988887777');
    await client.query(
      `INSERT INTO orders (id, organization_id, branch_id, customer_id, order_number, business_date,
                           status, fulfillment, payment_method, subtotal_cents, delivery_fee_cents,
                           discount_cents, total_cents, placed_at)
       VALUES ($1,$2,$3,$4,'CANCELADO',CURRENT_DATE,'CANCELLED','PICKUP','CASH_ON_SITE',90000,0,0,90000, now())`,
      [randomUUID(), acme.organizationId, acme.branchId, cliente.id],
    );

    const response = await buscar(gerente, 7).expect(200);
    expect(response.body.current.revenueCents).toBe(5000);
  });

  it('NÃO soma o faturamento da franquia concorrente', async () => {
    // A classe de vazamento que nenhum teste de "não vejo o pedido do outro"
    // pega: nenhuma linha de pedido sai na resposta, só um número que não
    // deveria existir.
    await venda(acme, 1, 1000);
    await venda(rival, 1, 500_000);

    const response = await buscar(gerente, 7).expect(200);
    expect(response.body.current.revenueCents).toBe(1000);
  });

  it('recusa período fora do limite', async () => {
    await buscar(gerente, 0).expect(400);
    await buscar(gerente, 999).expect(400);
  });

  it('o operador vê o faturamento APENAS da unidade dele', async () => {
    // A migração 0004 concede `report:read` ao operador de propósito: o item 8
    // pede que ele "visualize apenas a unidade autorizada", o que pressupõe que
    // visualize algo. O que precisa ser garantido é o ESCOPO, não a recusa.
    await venda(acme, 1, 3000, acme.branchId);
    await venda(acme, 1, 90_000, acme.secondBranchId);

    const operador = await request(baseUrl)
      .post('/v1/auth/login')
      .send({
        organizationSlug: acme.organizationSlug,
        email: acme.operatorEmail,
        password: acme.password,
      })
      .expect(201);

    const response = await buscar(operador.body.accessToken, 7).expect(200);
    expect(response.body.scope).toBe('BRANCHES');
    // A unidade vizinha não entra nem somada no total.
    expect(response.body.current.revenueCents).toBe(3000);
  });
});
