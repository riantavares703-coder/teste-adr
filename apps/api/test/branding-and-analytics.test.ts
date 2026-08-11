import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CONTRAST_AA_TEXT, contrastRatio } from '@plataforma/domain';
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
 * PROMPT 03 — aparência configurável e indicadores da franquia.
 *
 * Duas superfícies novas, dois riscos novos:
 *
 *  - APARÊNCIA é a única rota que grava algo que vira ESTILO na tela de todo
 *    cliente da loja. Se houvesse um caminho para texto livre virar CSS, seria
 *    aqui.
 *  - INDICADORES agregam. Vazamento por agregação não devolve linha nenhuma do
 *    outro tenant — devolve um número que não deveria existir. Nenhum teste de
 *    "não vejo o pedido alheio" pegaria isso, por isso estes existem.
 */
describe('Aparência da unidade e indicadores da franquia', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let acme: Fixture;
  let rival: Fixture;

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
  }, 120_000);

  async function loginStaff(fixture: Fixture, who: 'manager' | 'operator') {
    const res = await request(baseUrl).post('/v1/auth/login').send({
      organizationSlug: fixture.organizationSlug,
      email: who === 'manager' ? fixture.managerEmail : fixture.operatorEmail,
      password: fixture.password,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.accessToken as string;
  }

  const validBranding = {
    displayName: 'Burger do Centro',
    tagline: 'Artesanal desde 2019',
    primaryColor: '#ff5a00',
    secondaryColor: '#1f2937',
    accentColor: '#ffb000',
    textColor: '#111827',
    backgroundColor: '#ffffff',
    cardColor: '#f7f7f8',
    fontToken: 'POPPINS',
    gradientStyle: 'DIAGONAL',
    gradientFrom: '#ff5a00',
    gradientTo: '#ffb000',
  };

  function putBranding(token: string, branchId: string, body: Record<string, unknown>) {
    return request(baseUrl)
      .put(`/v1/branches/${branchId}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  // =========================================================================
  // Aparência
  // =========================================================================

  describe('aparência: gravação e leitura', () => {
    it('o gerente configura a identidade visual completa', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await putBranding(token, acme.branchId, validBranding);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.primaryColor).toBe('#ff5a00');
      expect(res.body.fontToken).toBe('POPPINS');
      expect(res.body.gradientStyle).toBe('DIAGONAL');
      expect(res.body.displayName).toBe('Burger do Centro');
    });

    it('a vitrine pública passa a servir o tema JÁ RESOLVIDO', async () => {
      const token = await loginStaff(acme, 'manager');
      await putBranding(token, acme.branchId, validBranding);

      const menu = await request(baseUrl).get(
        `/v1/public/${acme.organizationSlug}/${acme.branchSlug}/menu`,
      );
      expect(menu.status).toBe(200);
      expect(menu.body.theme.primary).toBe('#ff5a00');
      // Derivado no servidor, não configurado: o app não recalcula nada.
      expect(menu.body.theme.onPrimary).toBeDefined();
      expect(contrastRatio(menu.body.theme.primary, menu.body.theme.onPrimary)).toBeGreaterThanOrEqual(
        CONTRAST_AA_TEXT,
      );
      expect(menu.body.theme.fontFamily).toBe('Poppins');
      expect(menu.body.theme.gradient.colors).toEqual(['#ff5a00', '#ffb000']);
    });

    it('unidade sem configuração devolve o padrão da plataforma, não 404', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await request(baseUrl)
        .get(`/v1/branches/${acme.secondBranchId}/branding`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.primaryColor).toMatch(/^#[0-9a-f]{6}$/);
      expect(res.body.fontToken).toBe('INTER');
    });

    it('cada unidade guarda a própria identidade', async () => {
      const token = await loginStaff(acme, 'manager');
      await putBranding(token, acme.branchId, validBranding);
      await putBranding(token, acme.secondBranchId, {
        ...validBranding,
        displayName: 'Burger Zona Sul',
        primaryColor: '#0066cc',
      });

      const first = await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/branding`)
        .set('Authorization', `Bearer ${token}`);
      const second = await request(baseUrl)
        .get(`/v1/branches/${acme.secondBranchId}/branding`)
        .set('Authorization', `Bearer ${token}`);

      expect(first.body.primaryColor).toBe('#ff5a00');
      expect(second.body.primaryColor).toBe('#0066cc');
    });

    it('registra na auditoria apenas o que mudou', async () => {
      const token = await loginStaff(acme, 'manager');
      await putBranding(token, acme.branchId, validBranding);
      await putBranding(token, acme.branchId, { ...validBranding, primaryColor: '#00aa55' });

      const { rows } = await client.query(
        `SELECT metadata FROM audit_logs WHERE action = 'branding.update'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      );
      const changed = rows[0].metadata.changed;
      expect(Object.keys(changed)).toEqual(['primaryColor']);
      expect(changed.primaryColor).toEqual({ de: '#ff5a00', para: '#00aa55' });
    });
  });

  // =========================================================================
  // Aparência: a superfície de injeção
  // =========================================================================

  describe('aparência: nenhum caminho para estilo arbitrário', () => {
    it('recusa fonte fora da lista', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await putBranding(token, acme.branchId, {
        ...validBranding,
        fontToken: 'Comic Sans MS',
      });
      expect(res.status).toBe(400);
    });

    it('recusa URL de fonte remota', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await putBranding(token, acme.branchId, {
        ...validBranding,
        fontToken: 'https://evil.example/font.ttf',
      });
      expect(res.status).toBe(400);
    });

    it('recusa cor com payload de CSS anexado', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await putBranding(token, acme.branchId, {
        ...validBranding,
        primaryColor: '#fff; } body { background: url(https://evil.example/x) } .a {',
      });
      expect(res.status).toBe(400);
    });

    it('recusa campos não declarados — sem ignorar em silêncio', async () => {
      const token = await loginStaff(acme, 'manager');
      // O ponto do `.strict()`: quem tentar pendurar estilo num campo novo
      // recebe erro, em vez de achar que funcionou.
      for (const extra of [
        { customCss: 'body{display:none}' },
        { styleOverride: '<style>*{color:red}</style>' },
        { fontUrl: 'https://evil.example/f.css' },
        { logoStorageKey: '../../etc/passwd' },
        { organizationId: rival.organizationId },
      ]) {
        const res = await putBranding(token, acme.branchId, { ...validBranding, ...extra });
        expect(res.status, `deveria recusar ${JSON.stringify(extra)}`).toBe(400);
      }
    });

    it('recusa caractere invisível no nome do estabelecimento', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await putBranding(token, acme.branchId, {
        ...validBranding,
        displayName: 'Loja‮oãçatpecA',
      });
      expect(res.status).toBe(422);
      expect(res.body.details.issues[0].code).toBe('CARACTERE_NAO_PERMITIDO');
    });

    it('o banco recusa fonte inválida mesmo por fora da aplicação', async () => {
      // Segunda barreira: o tipo `brand_font` no PostgreSQL. Se um dia alguém
      // gravar por script, por migração ou por um endpoint novo, ainda não
      // passa.
      await expect(
        client.query(`UPDATE branding_settings SET font_token = 'COMIC_SANS' WHERE branch_id = $1`, [
          acme.branchId,
        ]),
      ).rejects.toThrow();
    });

    it('o banco recusa cor fora do formato mesmo por fora da aplicação', async () => {
      await expect(
        client.query(`UPDATE branding_settings SET primary_color = 'red' WHERE branch_id = $1`, [
          acme.branchId,
        ]),
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Aparência: acessibilidade como regra
  // =========================================================================

  describe('aparência: contraste é validado, não sugerido', () => {
    it('recusa texto ilegível sobre o fundo', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await putBranding(token, acme.branchId, {
        ...validBranding,
        textColor: '#eeeeee',
        backgroundColor: '#ffffff',
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('APARENCIA_INVALIDA');
      expect(res.body.details.issues.map((i: { code: string }) => i.code)).toContain(
        'CONTRASTE_INSUFICIENTE',
      );
    });

    it('recusa cor principal que desaparece no fundo', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await putBranding(token, acme.branchId, {
        ...validBranding,
        primaryColor: '#fdfdfd',
        backgroundColor: '#ffffff',
      });
      expect(res.status).toBe(422);
    });

    it('a configuração recusada NÃO é gravada', async () => {
      const token = await loginStaff(acme, 'manager');
      await putBranding(token, acme.branchId, validBranding);
      await putBranding(token, acme.branchId, { ...validBranding, textColor: '#f5f5f5' });

      const res = await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/branding`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.body.textColor).toBe('#111827');
    });
  });

  // =========================================================================
  // Aparência: autorização
  // =========================================================================

  describe('aparência: quem pode mexer', () => {
    it('o operador não altera a identidade visual', async () => {
      const token = await loginStaff(acme, 'operator');
      const res = await putBranding(token, acme.branchId, validBranding);
      expect(res.status).toBe(403);
    });

    it('o operador CONSEGUE ler a aparência da unidade dele', async () => {
      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/branding`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('gerente da RIVAL não altera a aparência da ACME — e recebe 404, não 403', async () => {
      const token = await loginStaff(rival, 'manager');
      const res = await putBranding(token, acme.branchId, validBranding);
      // 404 e não 403: um 403 confirmaria que a unidade existe.
      expect(res.status).toBe(404);
    });

    it('a marca da ACME permanece intacta após a tentativa da RIVAL', async () => {
      const acmeToken = await loginStaff(acme, 'manager');
      await putBranding(acmeToken, acme.branchId, validBranding);

      const rivalToken = await loginStaff(rival, 'manager');
      await putBranding(rivalToken, acme.branchId, { ...validBranding, primaryColor: '#000000' });

      const check = await request(baseUrl)
        .get(`/v1/branches/${acme.branchId}/branding`)
        .set('Authorization', `Bearer ${acmeToken}`);
      expect(check.body.primaryColor).toBe('#ff5a00');
    });

    it('sem autenticação não se altera aparência', async () => {
      const res = await request(baseUrl)
        .put(`/v1/branches/${acme.branchId}/branding`)
        .send(validBranding);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Escolha de unidade (vitrine pública)
  // =========================================================================

  describe('lista pública de unidades', () => {
    it('lista as unidades da franquia para a etapa de escolha', async () => {
      const res = await request(baseUrl).get(`/v1/public/${acme.organizationSlug}/branches`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((b: { slug: string }) => b.slug).sort()).toEqual(['centro', 'zona-sul']);
    });

    it('não expõe dado interno da unidade', async () => {
      const res = await request(baseUrl).get(`/v1/public/${acme.organizationSlug}/branches`);
      const [branch] = res.body;
      // A vitrine mostra endereço; não mostra telefone interno, coordenadas
      // nem qualquer campo de configuração.
      for (const leaked of ['phoneE164', 'latitude', 'longitude', 'organizationId', 'timezone']) {
        expect(branch, `vazou ${leaked}`).not.toHaveProperty(leaked);
      }
    });

    it('só lista unidades da franquia pedida', async () => {
      const res = await request(baseUrl).get(`/v1/public/${acme.organizationSlug}/branches`);
      const ids = res.body.map((b: { id: string }) => b.id);
      expect(ids).not.toContain(rival.branchId);
    });

    it('unidade arquivada não aparece na vitrine', async () => {
      await client.query(`UPDATE branches SET status = 'ARCHIVED' WHERE id = $1`, [
        acme.secondBranchId,
      ]);
      const res = await request(baseUrl).get(`/v1/public/${acme.organizationSlug}/branches`);
      expect(res.body).toHaveLength(1);
    });

    it('franquia inexistente devolve 404', async () => {
      const res = await request(baseUrl).get('/v1/public/nao-existe/branches');
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // Indicadores consolidados
  // =========================================================================

  describe('indicadores da franquia', () => {
    /** Cria um pedido concluído, para que ele conte como faturamento. */
    async function completedOrder(fixture: Fixture, branchId: string, totalCents: number) {
      const orderId = randomUUID();
      await client.query(
        `INSERT INTO orders (id, organization_id, branch_id, customer_id, order_number, status,
                             fulfillment, payment_method, subtotal_cents, total_cents, placed_at)
         VALUES ($1, $2, $3, $4, $5, 'DELIVERED', 'PICKUP', 'CASH_ON_SITE', $6, $6, now())`,
        [
          orderId,
          fixture.organizationId,
          branchId,
          (await seedCustomer(client, `+55119${Math.floor(Math.random() * 100_000_000)}`)).id,
          `A-${Math.floor(Math.random() * 100_000)}`,
          totalCents,
        ],
      );
      await client.query(
        `INSERT INTO order_items (id, order_id, product_id, product_name_snapshot,
                                  unit_price_cents_snapshot, quantity, line_total_cents)
         VALUES ($1, $2, $3, 'X-Burger', $4, 1, $4)`,
        [randomUUID(), orderId, fixture.productId, totalCents],
      );
      return orderId;
    }

    it('consolida pedidos, faturamento e ticket médio da franquia', async () => {
      await completedOrder(acme, acme.branchId, 3000);
      await completedOrder(acme, acme.branchId, 5000);
      await completedOrder(acme, acme.secondBranchId, 4000);

      const token = await loginStaff(acme, 'manager');
      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=30')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.scope).toBe('ORGANIZATION');
      expect(res.body.totals.orderCount).toBe(3);
      expect(res.body.totals.revenueCents).toBe(12000);
      expect(res.body.totals.averageTicketCents).toBe(4000);
    });

    it('quebra os indicadores por unidade', async () => {
      await completedOrder(acme, acme.branchId, 3000);
      await completedOrder(acme, acme.secondBranchId, 4000);

      const token = await loginStaff(acme, 'manager');
      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=30')
        .set('Authorization', `Bearer ${token}`);

      const byBranch = Object.fromEntries(
        res.body.byBranch.map((b: { branchId: string; revenueCents: number }) => [
          b.branchId,
          b.revenueCents,
        ]),
      );
      expect(byBranch[acme.branchId]).toBe(3000);
      expect(byBranch[acme.secondBranchId]).toBe(4000);
    });

    it('lista os produtos mais vendidos', async () => {
      await completedOrder(acme, acme.branchId, 3000);
      await completedOrder(acme, acme.branchId, 3000);

      const token = await loginStaff(acme, 'manager');
      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=30')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.topProducts[0]).toMatchObject({
        productId: acme.productId,
        productName: 'X-Burger',
        quantity: 2,
      });
    });

    it('pedido cancelado NÃO entra no faturamento', async () => {
      await completedOrder(acme, acme.branchId, 3000);
      const cancelled = await completedOrder(acme, acme.branchId, 90000);
      await client.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [cancelled]);

      const token = await loginStaff(acme, 'manager');
      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=30')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.totals.revenueCents).toBe(3000);
      expect(res.body.totals.cancelledCount).toBe(1);
    });

    it('respeita a janela de tempo pedida', async () => {
      const old = await completedOrder(acme, acme.branchId, 5000);
      await client.query(`UPDATE orders SET placed_at = now() - interval '40 days' WHERE id = $1`, [
        old,
      ]);
      await completedOrder(acme, acme.branchId, 3000);

      const token = await loginStaff(acme, 'manager');
      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=7')
        .set('Authorization', `Bearer ${token}`);
      expect(res.body.totals.revenueCents).toBe(3000);
    });

    it('sem pedidos, devolve zeros — nunca NaN nem divisão por zero', async () => {
      const token = await loginStaff(acme, 'manager');
      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=30')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.totals).toMatchObject({
        orderCount: 0,
        revenueCents: 0,
        averageTicketCents: 0,
      });
      expect(res.body.topProducts).toEqual([]);
    });

    it('recusa período fora da faixa', async () => {
      const token = await loginStaff(acme, 'manager');
      for (const days of ['0', '-5', '4000', 'abc']) {
        const res = await request(baseUrl)
          .get(`/v1/analytics/summary?days=${days}`)
          .set('Authorization', `Bearer ${token}`);
        expect(res.status, `days=${days}`).toBe(400);
      }
    });
  });

  // =========================================================================
  // Indicadores: o vazamento por agregação
  // =========================================================================

  describe('indicadores: escopo por unidade autorizada', () => {
    async function completedOrder(fixture: Fixture, branchId: string, totalCents: number) {
      const orderId = randomUUID();
      await client.query(
        `INSERT INTO orders (id, organization_id, branch_id, customer_id, order_number, status,
                             fulfillment, payment_method, subtotal_cents, total_cents, placed_at)
         VALUES ($1, $2, $3, $4, $5, 'DELIVERED', 'PICKUP', 'CASH_ON_SITE', $6, $6, now())`,
        [
          orderId,
          fixture.organizationId,
          branchId,
          (await seedCustomer(client, `+55119${Math.floor(Math.random() * 100_000_000)}`)).id,
          `B-${Math.floor(Math.random() * 100_000)}`,
          totalCents,
        ],
      );
      return orderId;
    }

    it('o operador soma APENAS a unidade dele', async () => {
      await completedOrder(acme, acme.branchId, 3000);
      await completedOrder(acme, acme.secondBranchId, 90000);

      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=30')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.scope).toBe('BRANCHES');
      expect(res.body.branchCount).toBe(1);
      // O faturamento da unidade vizinha não aparece nem somado ao total.
      expect(res.body.totals.revenueCents).toBe(3000);
      expect(res.body.byBranch.map((b: { branchId: string }) => b.branchId)).toEqual([
        acme.branchId,
      ]);
    });

    it('o operador não consulta outra unidade da PRÓPRIA franquia', async () => {
      const token = await loginStaff(acme, 'operator');
      const res = await request(baseUrl)
        .get(`/v1/analytics/summary?days=30&branchId=${acme.secondBranchId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('o gerente da RIVAL não consulta unidade da ACME', async () => {
      await completedOrder(acme, acme.branchId, 50000);

      const token = await loginStaff(rival, 'manager');
      const res = await request(baseUrl)
        .get(`/v1/analytics/summary?days=30&branchId=${acme.branchId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('o faturamento da ACME nunca aparece no consolidado da RIVAL', async () => {
      await completedOrder(acme, acme.branchId, 123456);
      await completedOrder(rival, rival.branchId, 1000);

      const token = await loginStaff(rival, 'manager');
      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=30')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.totals.revenueCents).toBe(1000);
      expect(res.body.byBranch.map((b: { branchId: string }) => b.branchId)).not.toContain(
        acme.branchId,
      );
    });

    it('cliente não acessa indicadores', async () => {
      const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
      const phone = '+5511933333333';
      await seedCustomer(client, phone);
      await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
      const code = app.get(OtpDeliveryService).getDevCode(phone)!;
      const login = await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code });

      const res = await request(baseUrl)
        .get('/v1/analytics/summary?days=30')
        .set('Authorization', `Bearer ${login.body.accessToken}`);
      expect(res.status).toBe(403);
    });

    it('sem autenticação não há indicadores', async () => {
      const res = await request(baseUrl).get('/v1/analytics/summary?days=30');
      expect(res.status).toBe(401);
    });
  });
});
