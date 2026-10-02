import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  TEST_DATABASE_URL,
  createTestApp,
  hashPassword,
  resetAll,
  seedCustomer,
  seedOrganization,
  setupDatabase,
  type Fixture,
} from './helpers/harness.js';
import { StorefrontService } from '../src/modules/storefront/storefront.service.js';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from '../src/common/default-credentials.js';

/**
 * LINK E QR CODE DO CARDÁPIO. O que se garante aqui: o endereço entregue ao
 * cliente só é tratado como "funciona de qualquer lugar" quando é público e
 * seguro, e publicar na internet não expõe a conta de demonstração.
 */
describe('Link do cardápio: alcance, endereço público e verificação', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let f: Fixture;
  const savedEnv = process.env.PUBLIC_BASE_URL;

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
    delete process.env.PUBLIC_BASE_URL;
  }, 120_000);

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = savedEnv;
    vi.restoreAllMocks();
  });

  async function login(who: 'manager' | 'operator', fixture: Fixture = f) {
    const res = await request(baseUrl).post('/v1/auth/login').send({
      organizationSlug: fixture.organizationSlug,
      email: who === 'manager' ? fixture.managerEmail : fixture.operatorEmail,
      password: fixture.password,
    });
    return res.body.accessToken as string;
  }

  const get = (token: string, headers: Record<string, string> = {}) =>
    request(baseUrl).get(`/v1/branches/${f.branchId}/share-link`).set('Authorization', `Bearer ${token}`).set(headers);

  const put = (token: string, publicBaseUrl: string | null, branchId = f.branchId) =>
    request(baseUrl)
      .put(`/v1/branches/${branchId}/share-link`)
      .set('Authorization', `Bearer ${token}`)
      .send({ publicBaseUrl });

  const check = (token: string, headers: Record<string, string> = {}) =>
    request(baseUrl).post(`/v1/branches/${f.branchId}/share-link/check`).set('Authorization', `Bearer ${token}`).set(headers);

  async function addDemoAdmin(password = DEFAULT_ADMIN_PASSWORD) {
    const { rows } = await client.query(`SELECT gen_random_uuid() AS id`);
    await client.query(
      `INSERT INTO users (id, type, organization_id, email, full_name, password_hash)
       VALUES ($1, 'STAFF', $2, $3, 'Administrador', $4)`,
      [rows[0].id, f.organizationId, DEFAULT_ADMIN_EMAIL, await hashPassword(password)],
    );
    return rows[0].id as string;
  }

  describe('de onde vem o endereço', () => {
    it('sem nada configurado: rede local ou só este computador, e NUNCA "público"', async () => {
      const res = await get(await login('operator')).expect(200);
      expect(['lan', 'local']).toContain(res.body.reach);
      expect(['lan', 'localhost']).toContain(res.body.source);
      expect(res.body.menuUrl.endsWith(`/acme/${f.branchSlug}`)).toBe(true);
      expect(res.body.publicBaseUrl).toBeNull();
      expect(res.body.warnings).toEqual([]);
    });

    it('PUBLIC_BASE_URL de rede local (o que o launcher define): alcance "lan"', async () => {
      process.env.PUBLIC_BASE_URL = 'http://192.168.0.10:3000';
      const res = await get(await login('operator')).expect(200);
      expect(res.body).toMatchObject({
        menuUrl: `http://192.168.0.10:3000/acme/${f.branchSlug}`,
        reach: 'lan',
        source: 'env',
        secure: false,
        reachableFromPhones: true,
      });
    });

    it('PUBLIC_BASE_URL público (hospedagem): alcance "public", sem barra sobrando', async () => {
      process.env.PUBLIC_BASE_URL = 'https://pedidos.exemplo.com.br/';
      const res = await get(await login('operator')).expect(200);
      expect(res.body).toMatchObject({
        menuUrl: `https://pedidos.exemplo.com.br/acme/${f.branchSlug}`,
        reach: 'public',
        source: 'env',
        secure: true,
      });
    });

    it('painel aberto por um endereço público (atrás de proxy): o link usa esse endereço', async () => {
      process.env.PUBLIC_BASE_URL = 'http://192.168.0.10:3000';
      const res = await get(await login('operator'), {
        'X-Forwarded-Host': 'loja.exemplo.com.br',
        'X-Forwarded-Proto': 'https',
      }).expect(200);
      expect(res.body).toMatchObject({
        menuUrl: `https://loja.exemplo.com.br/acme/${f.branchSlug}`,
        reach: 'public',
        source: 'request',
      });
    });

    it('cabeçalho de host malformado é ignorado, sem quebrar nem alterar o link', async () => {
      process.env.PUBLIC_BASE_URL = 'http://192.168.0.10:3000';
      const res = await get(await login('operator'), { 'X-Forwarded-Host': 'evil.com/phishing' }).expect(200);
      expect(res.body.source).toBe('env');
      expect(res.body.menuUrl).not.toContain('evil');
    });

    it('painel aberto por IP/localhost NÃO vira link público', async () => {
      const res = await get(await login('operator'), { 'X-Forwarded-Host': '192.168.1.50:3000' }).expect(200);
      expect(res.body.reach).not.toBe('public');
    });

    it('o endereço cadastrado pelo dono vence a variável e o painel', async () => {
      process.env.PUBLIC_BASE_URL = 'https://outro.exemplo.com.br';
      const manager = await login('manager');
      await put(manager, 'https://cardapio.minhaloja.com.br').expect(200);
      const res = await get(manager, { 'X-Forwarded-Host': 'terceiro.com.br', 'X-Forwarded-Proto': 'https' }).expect(200);
      expect(res.body).toMatchObject({
        menuUrl: `https://cardapio.minhaloja.com.br/acme/${f.branchSlug}`,
        source: 'setting',
        reach: 'public',
        publicBaseUrl: 'https://cardapio.minhaloja.com.br',
      });
    });
  });

  describe('cadastrar o endereço público', () => {
    it('guarda só a origem: caminho, parâmetros e âncora são descartados', async () => {
      const res = await put(await login('manager'), '  https://Cardapio.MinhaLoja.com.br/acme/centro?utm=1#x ').expect(200);
      expect(res.body.publicBaseUrl).toBe('https://cardapio.minhaloja.com.br');
      const { rows } = await client.query('SELECT public_base_url FROM store_settings WHERE branch_id = $1', [f.branchId]);
      expect(rows[0].public_base_url).toBe('https://cardapio.minhaloja.com.br');
    });

    it('completa https quando o dono cola só o domínio', async () => {
      const res = await put(await login('manager'), 'minhaloja.com.br').expect(200);
      expect(res.body.publicBaseUrl).toBe('https://minhaloja.com.br');
    });

    it.each([
      ['http://minhaloja.com.br', 'NOT_HTTPS'],
      ['https://192.168.0.5', 'NOT_PUBLIC'],
      ['https://localhost:3000', 'NOT_PUBLIC'],
      ['https://loja-pc', 'NOT_PUBLIC'],
      ['https://user:senha@minhaloja.com.br', 'HAS_CREDENTIALS'],
      ['https://8.8.8.8', 'IP_LITERAL'],
      ['javascript:alert(1)', 'INVALID_URL'],
      ['https://', 'INVALID_URL'],
    ])('recusa %s com o motivo %s e NÃO grava nada', async (input, reason) => {
      const res = await put(await login('manager'), input);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ENDERECO_INVALIDO');
      expect(res.body.details.reason).toBe(reason);
      const { rows } = await client.query('SELECT public_base_url FROM store_settings WHERE branch_id = $1', [f.branchId]);
      expect(rows[0].public_base_url).toBeNull();
    });

    it('o banco também recusa http e lixo, mesmo se a aplicação falhasse', async () => {
      for (const bad of ['http://minhaloja.com.br', 'https://a.com/caminho', 'https://u@a.com', 'https://a b.com']) {
        await expect(
          client.query('UPDATE store_settings SET public_base_url = $2 WHERE branch_id = $1', [f.branchId, bad]),
        ).rejects.toThrow(/store_settings_public_base_url_https/);
      }
    });

    it('null (ou vazio) remove o endereço e o link volta ao que havia antes', async () => {
      const manager = await login('manager');
      await put(manager, 'https://minhaloja.com.br').expect(200);
      const cleared = await put(manager, null).expect(200);
      expect(cleared.body.publicBaseUrl).toBeNull();
      expect(cleared.body.source).not.toBe('setting');
      const blank = await put(manager, '   ').expect(200);
      expect(blank.body.publicBaseUrl).toBeNull();
    });

    it('a alteração fica na auditoria, com o endereço', async () => {
      await put(await login('manager'), 'https://minhaloja.com.br').expect(200);
      const { rows } = await client.query(`SELECT metadata FROM audit_logs WHERE action = 'share_link.updated'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata.publicBaseUrl).toBe('https://minhaloja.com.br');
    });

    it('corpo com campo desconhecido é recusado', async () => {
      const res = await request(baseUrl)
        .put(`/v1/branches/${f.branchId}/share-link`)
        .set('Authorization', `Bearer ${await login('manager')}`)
        .send({ publicBaseUrl: 'https://minhaloja.com.br', extra: 1 });
      expect(res.status).toBe(400);
    });
  });

  describe('quem pode o quê', () => {
    it('o operador do balcão VÊ o link, mas não consegue alterá-lo nem testá-lo', async () => {
      const operator = await login('operator');
      await get(operator).expect(200);
      expect((await put(operator, 'https://minhaloja.com.br')).status).toBe(403);
      expect((await check(operator)).status).toBe(403);
    });

    it('sem login: 401 nas três rotas', async () => {
      expect((await request(baseUrl).get(`/v1/branches/${f.branchId}/share-link`)).status).toBe(401);
      expect((await request(baseUrl).put(`/v1/branches/${f.branchId}/share-link`).send({ publicBaseUrl: null })).status).toBe(401);
      expect((await request(baseUrl).post(`/v1/branches/${f.branchId}/share-link/check`)).status).toBe(401);
    });

    it('cliente não acessa', async () => {
      const phone = '+5584988887777';
      await seedCustomer(client, phone);
      const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
      await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
      const code = app.get(OtpDeliveryService).getDevCode(phone)!;
      const token = (await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code })).body.accessToken as string;
      expect((await get(token)).status).toBe(403);
      expect((await put(token, 'https://minhaloja.com.br')).status).toBe(403);
    });

    it('gerente de OUTRA franquia não lê nem altera: 404, sem confirmar que a unidade existe', async () => {
      const rival = await seedOrganization(client, { slug: 'rival' });
      const rivalManager = await login('manager', rival);
      expect((await get(rivalManager)).status).toBe(404);
      expect((await put(rivalManager, 'https://invasor.com.br')).status).toBe(404);
      expect((await check(rivalManager)).status).toBe(404);
      const { rows } = await client.query('SELECT public_base_url FROM store_settings WHERE branch_id = $1', [f.branchId]);
      expect(rows[0].public_base_url).toBeNull();
    });
  });

  describe('segurança ao publicar: a senha da conta de demonstração', () => {
    it('link público + senha padrão ainda valendo: aviso na tela', async () => {
      await addDemoAdmin();
      process.env.PUBLIC_BASE_URL = 'https://pedidos.exemplo.com.br';
      const res = await get(await login('operator')).expect(200);
      expect(res.body.warnings).toContain('DEFAULT_ADMIN_PASSWORD');
    });

    it('link só de rede local: sem esse aviso (o painel não está na internet)', async () => {
      await addDemoAdmin();
      process.env.PUBLIC_BASE_URL = 'http://192.168.0.10:3000';
      const res = await get(await login('operator')).expect(200);
      expect(res.body.warnings).not.toContain('DEFAULT_ADMIN_PASSWORD');
    });

    it('cadastrar endereço público com a senha padrão ativa é RECUSADO e nada é gravado', async () => {
      await addDemoAdmin();
      const res = await put(await login('manager'), 'https://minhaloja.com.br');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SENHA_PADRAO_ATIVA');
      const { rows } = await client.query('SELECT public_base_url FROM store_settings WHERE branch_id = $1', [f.branchId]);
      expect(rows[0].public_base_url).toBeNull();
    });

    it('remover o endereço continua permitido mesmo com a senha padrão', async () => {
      await addDemoAdmin();
      expect((await put(await login('manager'), null)).status).toBe(200);
    });

    it('depois de trocar a senha da conta, publicar é permitido e o aviso some', async () => {
      const id = await addDemoAdmin();
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await hashPassword('uma-senha-nova-bem-longa')]);
      process.env.PUBLIC_BASE_URL = 'https://pedidos.exemplo.com.br';
      const manager = await login('manager');
      expect((await get(manager)).body.warnings).toEqual([]);
      expect((await put(manager, 'https://minhaloja.com.br')).status).toBe(200);
    });

    it('conta de demonstração DESATIVADA não conta como exposta', async () => {
      const id = await addDemoAdmin();
      await client.query('UPDATE users SET is_active = false WHERE id = $1', [id]);
      expect((await put(await login('manager'), 'https://minhaloja.com.br')).status).toBe(200);
    });

    it('a conta de demonstração de OUTRA franquia não bloqueia esta', async () => {
      const rival = await seedOrganization(client, { slug: 'rival' });
      await client.query(
        `INSERT INTO users (id, type, organization_id, email, full_name, password_hash)
         VALUES (gen_random_uuid(), 'STAFF', $1, $2, 'Admin', $3)`,
        [rival.organizationId, DEFAULT_ADMIN_EMAIL, await hashPassword(DEFAULT_ADMIN_PASSWORD)],
      );
      expect((await put(await login('manager'), 'https://minhaloja.com.br')).status).toBe(200);
    });

    it('link público em http (sem criptografia): aviso', async () => {
      process.env.PUBLIC_BASE_URL = 'http://pedidos.exemplo.com.br';
      const res = await get(await login('operator')).expect(200);
      expect(res.body).toMatchObject({ reach: 'public', secure: false });
      expect(res.body.warnings).toContain('INSECURE_HTTP');
    });
  });

  describe('verificar o endereço', () => {
    it('endereço de rede local não tem o que verificar: NOT_PUBLIC, sem fazer chamada de rede', async () => {
      process.env.PUBLIC_BASE_URL = 'http://192.168.0.10:3000';
      const probe = vi.spyOn(app.get(StorefrontService), 'probe');
      const res = await check(await login('manager')).expect(201);
      expect(res.body).toMatchObject({ ok: false, reason: 'NOT_PUBLIC' });
      expect(probe).not.toHaveBeenCalled();
    });

    it('endereço público: pergunta à verificação, com a origem, o slug e a unidade corretos', async () => {
      const manager = await login('manager');
      await put(manager, 'https://minhaloja.com.br').expect(200);
      const probe = vi.spyOn(app.get(StorefrontService), 'probe').mockResolvedValue({ ok: true });

      const res = await check(manager).expect(201);

      expect(res.body).toEqual({ ok: true, checkedUrl: `https://minhaloja.com.br/acme/${f.branchSlug}` });
      expect(probe).toHaveBeenCalledWith(
        'https://minhaloja.com.br',
        { organizationSlug: 'acme', branchId: f.branchId },
        expect.objectContaining({ allowPrivateTargets: false }),
      );
    });

    it.each([
      [{ ok: false, reason: 'UNREACHABLE' }, { ok: false, reason: 'UNREACHABLE' }],
      [{ ok: false, reason: 'NOT_THIS_SYSTEM' }, { ok: false, reason: 'NOT_THIS_SYSTEM' }],
      [{ ok: false, reason: 'HTTP_STATUS', httpStatus: 502 }, { ok: false, reason: 'HTTP_STATUS', httpStatus: 502 }],
    ] as const)('repassa a falha %j', async (probeResult, expected) => {
      const manager = await login('manager');
      await put(manager, 'https://minhaloja.com.br').expect(200);
      vi.spyOn(app.get(StorefrontService), 'probe').mockResolvedValue(probeResult as never);
      const res = await check(manager).expect(201);
      expect(res.body).toMatchObject(expected);
    });

    it('sem stub, um domínio que não existe resulta em UNREACHABLE (e não em erro 500)', async () => {
      const manager = await login('manager');
      await put(manager, 'https://cardapio-que-nao-existe.invalid').expect(200);
      const res = await check(manager).expect(201);
      expect(res.body).toMatchObject({ ok: false, reason: 'UNREACHABLE' });
    }, 30_000);
  });
});
