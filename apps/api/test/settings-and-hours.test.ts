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
 * CONFIGURAÇÕES DA LOJA E HORÁRIO DE FUNCIONAMENTO.
 *
 * A tabela `business_hours` existia desde a primeira migração mas nenhum código
 * a consultava — a loja nunca fechava. Estes testes cobrem os dois lados que
 * isso destrava: o cardápio INFORMAR que está fechado, e o checkout RECUSAR.
 */
describe('Configurações da loja e horário de funcionamento', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let acme: Fixture;
  let rival: Fixture;
  let gerente: string;
  let operador: string;

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

  async function login(email: string, slug: string, password: string) {
    const response = await request(baseUrl)
      .post('/v1/auth/login')
      .send({ organizationSlug: slug, email, password })
      .expect(201);
    return response.body.accessToken as string;
  }

  beforeEach(async () => {
    await resetAll(client);
    acme = await seedOrganization(client, { slug: 'acme' });
    rival = await seedOrganization(client, { slug: 'rival' });
    gerente = await login(acme.managerEmail, acme.organizationSlug, acme.password);
    operador = await login(acme.operatorEmail, acme.organizationSlug, acme.password);
  });

  /** Dia da semana de hoje e de um dia que garantidamente não é hoje. */
  const hoje = () => new Date().getDay();
  const outroDia = () => (new Date().getDay() + 3) % 7;

  describe('configurações', () => {
    it('lê os valores padrão da unidade', async () => {
      const response = await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/settings`)
        .set('Authorization', `Bearer ${gerente}`)
        .expect(200);

      expect(response.body.preparationTimeMinutes).toBe(20);
      expect(response.body.enabledPaymentMethods).toContain('PIX');
      expect(response.body.hours).toEqual([]);
    });

    it('grava o tempo de preparo', async () => {
      const response = await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/settings`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({ preparationTimeMinutes: 45 })
        .expect(200);

      expect(response.body.preparationTimeMinutes).toBe(45);
    });

    it('o tempo de preparo gravado vira a previsão do pedido', async () => {
      // É esse valor que alimenta a barra de progresso do cliente.
      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/settings`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({ preparationTimeMinutes: 40 })
        .expect(200);

      const guest = await request(baseUrl)
        .post('/v1/auth/guest')
        .send({ phone: '+5511977770001', fullName: 'Cliente Preparo' })
        .expect(201);

      const created = await request(baseUrl)
        .post('/v1/orders')
        .set('Authorization', `Bearer ${guest.body.accessToken}`)
        .set('Idempotency-Key', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
        .send({
          branchId: acme.branchId,
          fulfillment: 'PICKUP',
          paymentMethod: 'CASH_ON_SITE',
          items: [{ productId: acme.productId, quantity: 1 }],
        })
        .expect(201);

      const previsto = new Date(created.body.order.estimatedReadyAt).getTime();
      const feito = new Date(created.body.order.placedAt).getTime();
      expect(Math.round((previsto - feito) / 60_000)).toBe(40);
    });

    it('recusa deixar a loja sem forma de pagamento', async () => {
      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/settings`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({ enabledPaymentMethods: [] })
        .expect(400);
    });

    it('o operador vê as configurações mas não as altera', async () => {
      await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/settings`)
        .set('Authorization', `Bearer ${operador}`)
        .expect(200);

      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/settings`)
        .set('Authorization', `Bearer ${operador}`)
        .send({ preparationTimeMinutes: 5 })
        .expect(403);
    });

    it('uma franquia não lê nem grava a configuração da outra', async () => {
      const rivalToken = await login(rival.managerEmail, rival.organizationSlug, rival.password);

      await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/settings`)
        .set('Authorization', `Bearer ${rivalToken}`)
        .expect(404);

      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/settings`)
        .set('Authorization', `Bearer ${rivalToken}`)
        .send({ preparationTimeMinutes: 1 })
        .expect(404);
    });
  });

  describe('horário de funcionamento', () => {
    it('grava e devolve o horário ordenado', async () => {
      const response = await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/hours`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({
          hours: [
            { weekday: 3, opensAt: '18:00', closesAt: '23:00' },
            { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
          ],
        })
        .expect(200);

      expect(response.body.hours).toEqual([
        { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
        { weekday: 3, opensAt: '18:00', closesAt: '23:00' },
      ]);
    });

    it('aceita duas faixas no mesmo dia (almoço e jantar)', async () => {
      const response = await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/hours`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({
          hours: [
            { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
            { weekday: 1, opensAt: '18:00', closesAt: '23:00' },
          ],
        })
        .expect(200);

      expect(response.body.hours).toHaveLength(2);
    });

    it('recusa faixas sobrepostas explicando qual dia', async () => {
      const response = await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/hours`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({
          hours: [
            { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
            { weekday: 1, opensAt: '14:00', closesAt: '18:00' },
          ],
        })
        .expect(422);

      expect(response.body.code).toBe('HORARIO_INVALIDO');
      // A recusa precisa dizer QUAL dia conflita; "horário inválido" sozinho
      // deixa o lojista caçando o erro num formulário de sete linhas.
      expect(response.body.title).toContain('Segunda');
    });

    it('substitui o conjunto inteiro em vez de acumular', async () => {
      const enviar = (hours: unknown[]) =>
        request(baseUrl)
          .put(`/v1/branches/${acme.branchId}/hours`)
          .set('Authorization', `Bearer ${gerente}`)
          .send({ hours })
          .expect(200);

      await enviar([{ weekday: 1, opensAt: '11:00', closesAt: '15:00' }]);
      const segundo = await enviar([{ weekday: 2, opensAt: '09:00', closesAt: '12:00' }]);

      expect(segundo.body.hours).toEqual([{ weekday: 2, opensAt: '09:00', closesAt: '12:00' }]);
    });

    it('esvaziar o horário deixa a loja sempre aberta', async () => {
      const response = await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/hours`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({ hours: [] })
        .expect(200);

      // Sem horário cadastrado a loja vende: o lojista não perde venda por uma
      // configuração que ainda não sabe que existe.
      expect(response.body.open.isOpen).toBe(true);
      expect(response.body.open.hasSchedule).toBe(false);
    });
  });

  describe('o cardápio informa o estado da loja', () => {
    it('aberta quando o horário de hoje cobre agora', async () => {
      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/hours`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({ hours: [{ weekday: hoje(), opensAt: '00:00', closesAt: '23:59' }] })
        .expect(200);

      const menu = await request(baseUrl)
        .get(`/v1/public/${acme.organizationSlug}/${acme.branchSlug}/menu`)
        .expect(200);

      expect(menu.body.open.isOpen).toBe(true);
    });

    it('fechada quando só há horário em outro dia, e diz quando abre', async () => {
      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/hours`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({ hours: [{ weekday: outroDia(), opensAt: '10:00', closesAt: '12:00' }] })
        .expect(200);

      const menu = await request(baseUrl)
        .get(`/v1/public/${acme.organizationSlug}/${acme.branchSlug}/menu`)
        .expect(200);

      expect(menu.body.open.isOpen).toBe(false);
      expect(menu.body.open.next.weekday).toBe(outroDia());
    });
  });

  describe('o checkout RECUSA com a loja fechada', () => {
    async function pedir(chave: string) {
      const guest = await request(baseUrl)
        .post('/v1/auth/guest')
        .send({ phone: '+5511977770002', fullName: 'Cliente Fora de Hora' })
        .expect(201);

      return request(baseUrl)
        .post('/v1/orders')
        .set('Authorization', `Bearer ${guest.body.accessToken}`)
        .set('Idempotency-Key', chave)
        .send({
          branchId: acme.branchId,
          fulfillment: 'PICKUP',
          paymentMethod: 'CASH_ON_SITE',
          items: [{ productId: acme.productId, quantity: 1 }],
        });
    }

    it('recusa o pedido fora do horário, mesmo com a página aberta desde antes', async () => {
      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/hours`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({ hours: [{ weekday: outroDia(), opensAt: '10:00', closesAt: '12:00' }] })
        .expect(200);

      const response = await pedir('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('LOJA_FECHADA');
    });

    it('aceita o pedido dentro do horário', async () => {
      await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/hours`)
        .set('Authorization', `Bearer ${gerente}`)
        .send({ hours: [{ weekday: hoje(), opensAt: '00:00', closesAt: '23:59' }] })
        .expect(200);

      const response = await pedir('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2');
      expect(response.status).toBe(201);
    });

    it('sem horário cadastrado o pedido passa', async () => {
      const response = await pedir('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3');
      expect(response.status).toBe(201);
    });
  });
});
