import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
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

/** Itens 2 (fotos), 11 (tempo real), 12 (push) e 13 (WhatsApp) do Prompt 02. */
describe('Mídia, notificações e integrações', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let f: Fixture;
  let managerToken: string;

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
    const res = await request(baseUrl).post('/v1/auth/login').send({
      organizationSlug: f.organizationSlug,
      email: f.managerEmail,
      password: f.password,
    });
    managerToken = res.body.accessToken;
  }, 120_000);

  async function jpeg(width = 800, height = 600): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } },
    })
      .jpeg()
      .toBuffer();
  }

  function upload(buffer: Buffer, contentType: string, query = '') {
    return request(baseUrl)
      .post(`/v1/branches/${f.branchId}/products/${f.productId}/images${query}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('Content-Type', contentType)
      .send(buffer);
  }

  // === UPLOAD DE FOTOS (item 2) ==============================================

  describe('upload de fotos', () => {
    it('aceita JPEG e gera as variantes', async () => {
      const res = await upload(await jpeg(), 'image/jpeg', '?primary=true');
      expect(res.status).toBe(201);
      expect(res.body.storageKey).toMatch(/^[0-9a-f-]{36}\.webp$/);
      expect(res.body.thumbStorageKey).toMatch(/_sm\.webp$/);
      expect(res.body.mediumStorageKey).toMatch(/_md\.webp$/);
      expect(res.body.width).toBeLessThanOrEqual(1600);
    });

    it('o nome enviado pelo usuário NUNCA vira chave de armazenamento', async () => {
      const res = await upload(await jpeg(), 'image/jpeg');
      // Chave é UUID do servidor: path traversal deixa de ser possível.
      expect(res.body.storageKey).not.toContain('..');
      expect(res.body.storageKey).not.toContain('/');
    });

    it('recusa executável renomeado como imagem (magic bytes)', async () => {
      // ELF header + conteúdo — content-type mente, o conteúdo não.
      const elf = Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
        Buffer.alloc(1000, 0x90),
      ]);
      const res = await upload(elf, 'image/jpeg');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CONTEUDO_NAO_E_IMAGEM');
    });

    it('recusa tipo declarado divergente do conteúdo', async () => {
      const res = await upload(await jpeg(), 'image/png');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('TIPO_DIVERGENTE');
    });

    it('recusa tipo fora da allowlist (SVG com script, por exemplo)', async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const res = await request(baseUrl)
        .post(`/v1/branches/${f.branchId}/products/${f.productId}/images`)
        .set('Authorization', `Bearer ${managerToken}`)
        .set('Content-Type', 'image/svg+xml')
        .send(svg);
      expect([400, 415, 422]).toContain(res.status);
    });

    it('o reprocessamento destrói payload anexado após o fim do JPEG', async () => {
      const original = await jpeg();
      const polyglot = Buffer.concat([original, Buffer.from('<?php system($_GET["c"]); ?>')]);

      const res = await upload(polyglot, 'image/jpeg');
      expect(res.status).toBe(201);

      // A imagem é REESCRITA a partir dos pixels: o apêndice não é copiado.
      const served = await request(baseUrl).get(`/v1/media/${res.body.storageKey}`).expect(200);
      expect(served.body.toString('latin1')).not.toContain('php');
      expect(served.headers['content-type']).toBe('image/webp');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
    });

    it('remove metadados EXIF', async () => {
      const withExif = await sharp({
        create: { width: 100, height: 100, channels: 3, background: '#123456' },
      })
        .withMetadata({ exif: { IFD0: { Copyright: 'SEGREDO', Software: 'camera' } } })
        .jpeg()
        .toBuffer();

      const res = await upload(withExif, 'image/jpeg');
      expect(res.status).toBe(201);

      const served = await request(baseUrl).get(`/v1/media/${res.body.storageKey}`);
      const metadata = await sharp(served.body).metadata();
      expect(metadata.exif).toBeUndefined();
    });

    it('recusa arquivo acima do limite', async () => {
      const big = Buffer.alloc(6 * 1024 * 1024, 0);
      big[0] = 0xff;
      big[1] = 0xd8;
      big[2] = 0xff;
      const res = await upload(big, 'image/jpeg');
      expect([413, 422]).toContain(res.status);
    });

    it('path traversal na leitura devolve 404, não o arquivo', async () => {
      for (const key of ['../../../etc/passwd', '..%2f..%2fetc%2fpasswd', 'nao-existe.webp']) {
        const res = await request(baseUrl).get(`/v1/media/${encodeURIComponent(key)}`);
        expect(res.status).toBe(404);
      }
    });

    it('operador de outra franquia não envia foto para produto alheio', async () => {
      const rival = await seedOrganization(client, { slug: 'rival' });
      const login = await request(baseUrl).post('/v1/auth/login').send({
        organizationSlug: rival.organizationSlug,
        email: rival.managerEmail,
        password: rival.password,
      });
      const res = await request(baseUrl)
        .post(`/v1/branches/${rival.branchId}/products/${f.productId}/images`)
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .set('Content-Type', 'image/jpeg')
        .send(await jpeg());
      expect(res.status).toBe(404);
    });

    it('remoção apaga o registro e as variantes', async () => {
      const uploaded = await upload(await jpeg(), 'image/jpeg');
      const del = await request(baseUrl)
        .delete(`/v1/branches/${f.branchId}/products/images/${uploaded.body.imageId}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(del.status).toBe(200);

      const served = await request(baseUrl).get(`/v1/media/${uploaded.body.storageKey}`);
      expect(served.status).toBe(404);
    });
  });

  // === NOTIFICAÇÕES (itens 12 e 13) ==========================================

  describe('notificações desacopladas', () => {
    async function placeOrder() {
      const phone = `+55119${String(Date.now()).slice(-8)}`;
      await seedCustomer(client, phone);
      const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
      await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
      const code = app.get(OtpDeliveryService).getDevCode(phone)!;
      const login = await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code });

      const res = await request(baseUrl)
        .post('/v1/orders')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          branchId: f.branchId,
          fulfillment: 'PICKUP',
          paymentMethod: 'CASH_ON_SITE',
          items: [{ productId: f.productId, quantity: 1 }],
        });
      return { orderId: res.body.order.id as string, token: login.body.accessToken as string };
    }

    it('criar pedido grava o evento no outbox NA MESMA transação', async () => {
      const { orderId } = await placeOrder();
      const { rows } = await client.query(
        `SELECT event_type, published_at FROM outbox_events WHERE aggregate_id = $1`,
        [orderId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].event_type).toBe('order.created');
      expect(rows[0].published_at).toBeNull(); // ainda não entregue
    });

    it('o pedido é criado mesmo sem NENHUM provedor configurado', async () => {
      const { orderId } = await placeOrder();
      const { NotificationService } = await import(
        '../src/modules/notifications/notification.service.js'
      );
      const result = await app.get(NotificationService).drainOutbox();
      expect(result.failed).toBe(0);

      const order = await client.query('SELECT status FROM orders WHERE id = $1', [orderId]);
      expect(order.rows[0].status).toBe('PENDING');
    });

    it('sem provedor, a notificação fica SKIPPED com motivo — nunca "enviada"', async () => {
      const { orderId } = await placeOrder();
      // Sem opt-in, o motivo é a ausência de consentimento.
      const { NotificationService } = await import(
        '../src/modules/notifications/notification.service.js'
      );
      await app.get(NotificationService).drainOutbox();

      const { rows } = await client.query(
        `SELECT status, failure_reason, sent_at FROM notifications WHERE order_id = $1`,
        [orderId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('SKIPPED');
      expect(rows[0].failure_reason).toBe('SEM_OPT_IN_WHATSAPP');
      expect(rows[0].sent_at).toBeNull();
    });

    it('com opt-in mas sem credencial, o motivo é PROVEDOR NÃO CONFIGURADO', async () => {
      const { orderId } = await placeOrder();
      await client.query('UPDATE customer_organization_links SET whatsapp_opt_in = true');

      const { NotificationService } = await import(
        '../src/modules/notifications/notification.service.js'
      );
      await app.get(NotificationService).drainOutbox();

      const { rows } = await client.query(
        `SELECT status, failure_reason FROM notifications WHERE order_id = $1`,
        [orderId],
      );
      expect(rows[0].status).toBe('SKIPPED');
      expect(rows[0].failure_reason).toBe('WHATSAPP_PROVIDER_NOT_CONFIGURED');
    });

    it('o outbox é drenado e marcado como publicado', async () => {
      const { orderId } = await placeOrder();
      const { NotificationService } = await import(
        '../src/modules/notifications/notification.service.js'
      );
      await app.get(NotificationService).drainOutbox();

      const { rows } = await client.query(
        `SELECT published_at FROM outbox_events WHERE aggregate_id = $1`,
        [orderId],
      );
      expect(rows[0].published_at).not.toBeNull();
    });

    it('reprocessar o mesmo evento NÃO duplica a mensagem ao cliente', async () => {
      const { orderId } = await placeOrder();
      const { NotificationService } = await import(
        '../src/modules/notifications/notification.service.js'
      );
      const service = app.get(NotificationService);
      await service.drainOutbox();

      // Simula a entrega at-least-once do outbox.
      await client.query('UPDATE outbox_events SET published_at = NULL, next_attempt_at = now()');
      await service.drainOutbox();

      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM notifications WHERE order_id = $1 AND channel = 'WHATSAPP'`,
        [orderId],
      );
      expect(rows[0].n).toBe(1);
    });

    it('cada transição de status gera seu próprio template', async () => {
      const { orderId } = await placeOrder();
      await request(baseUrl)
        .post(`/v1/branches/${f.branchId}/orders/${orderId}/transition`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ to: 'CONFIRMED' })
        .expect(201);

      const { NotificationService } = await import(
        '../src/modules/notifications/notification.service.js'
      );
      await app.get(NotificationService).drainOutbox();

      const { rows } = await client.query(
        `SELECT template_name FROM notifications WHERE order_id = $1 ORDER BY created_at`,
        [orderId],
      );
      expect(rows.map((r) => r.template_name).sort()).toEqual([
        'pedido_confirmado',
        'pedido_recebido',
      ]);
    });

    it('o adapter de registro guarda o que TERIA sido enviado, para inspeção', async () => {
      const { orderId } = await placeOrder();
      await client.query('UPDATE customer_organization_links SET whatsapp_opt_in = true');

      const { NotificationService, WHATSAPP_PROVIDER } = await import(
        '../src/modules/notifications/notification.service.js'
      );
      const provider = app.get(WHATSAPP_PROVIDER) as {
        sent: Array<{ templateName: string; variables: string[] }>;
        isConfigured: boolean;
      };
      await app.get(NotificationService).drainOutbox();

      expect(provider.isConfigured).toBe(false);
      const message = provider.sent.find((m) => m.templateName === 'pedido_recebido');
      expect(message).toBeDefined();
      // Variáveis do template: número do pedido, unidade e valor formatado.
      expect(message!.variables[0]).toMatch(/^\d{4}$/);
      expect(message!.variables[2]).toBe('R$ 29,90');
      void orderId;
    });
  });

  // === AUDITORIA =============================================================

  describe('auditoria', () => {
    it('a cadeia de hash fecha após várias operações', async () => {
      await request(baseUrl)
        .patch(`/v1/branches/${f.branchId}/products/${f.productId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ priceCents: 3200 });
      await request(baseUrl)
        .post(`/v1/branches/${f.branchId}/inventory/${f.productId}/sold-out`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({});

      const { Database } = await import('../src/db/client.js');
      const { AuditService } = await import('../src/modules/audit/audit.service.js');
      const db = app.get(Database);
      const audit = app.get(AuditService);

      const result = await db.withPlatform((tx) => audit.verifyChain(tx, f.organizationId));
      expect(result.ok).toBe(true);
    });

    it('adulterar um registro quebra a cadeia de forma detectável', async () => {
      await request(baseUrl)
        .patch(`/v1/branches/${f.branchId}/products/${f.productId}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ priceCents: 3200 });

      // UPDATE direto é bloqueado pelo trigger; o adversário teria que
      // desabilitá-lo. Fazemos isso aqui para provar que a cadeia detecta.
      await client.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
      await client.query(`UPDATE audit_logs SET metadata = '{"from":0,"to":0}'::jsonb`);
      await client.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');

      const { Database } = await import('../src/db/client.js');
      const { AuditService } = await import('../src/modules/audit/audit.service.js');
      const result = await app
        .get(Database)
        .withPlatform((tx) => app.get(AuditService).verifyChain(tx, f.organizationId));
      expect(result.ok).toBe(false);
      expect(result.brokenAt).toBeDefined();
    });

    it('a aplicação não consegue alterar nem apagar a trilha', async () => {
      await request(baseUrl)
        .post(`/v1/branches/${f.branchId}/inventory/${f.productId}/sold-out`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({});

      await expect(client.query('UPDATE audit_logs SET action = $1', ['forjado'])).rejects.toThrow(
        /append-only/,
      );
      await expect(client.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    });
  });
});
