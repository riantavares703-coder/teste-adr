import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { DEFAULT_ADMIN_PASSWORD } from '../src/common/default-credentials.js';

const NEW_PASSWORD = 'uma-senha-nova-e-longa-2026';

describe('Troca de senha do operador', () => {
  let app: INestApplication;
  let baseUrl: string;
  let client: pg.Client;
  let f: Fixture;

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
  }, 120_000);

  const login = (password = f.password, email = f.managerEmail) =>
    request(baseUrl).post('/v1/auth/login').send({ organizationSlug: f.organizationSlug, email, password });

  const change = (token: string, body: Record<string, unknown>) =>
    request(baseUrl).post('/v1/auth/password').set('Authorization', `Bearer ${token}`).send(body);

  async function session() {
    const res = await login().expect(201);
    return res.body as { accessToken: string; refreshToken: string };
  }

  const me = (token: string) => request(baseUrl).get('/v1/auth/me').set('Authorization', `Bearer ${token}`);

  it('troca a senha e devolve uma sessão nova que já funciona', async () => {
    const s = await session();
    const res = await change(s.accessToken, { currentPassword: f.password, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect((await me(res.body.accessToken)).status).toBe(200);
  });

  it('a senha antiga deixa de entrar e a nova entra', async () => {
    const s = await session();
    await change(s.accessToken, { currentPassword: f.password, newPassword: NEW_PASSWORD }).expect(201);
    expect((await login(f.password)).status).toBe(401);
    expect((await login(NEW_PASSWORD)).status).toBe(201);
  });

  it('o token e a sessão ANTERIORES caem na hora (quem tinha a senha antiga perde o acesso)', async () => {
    const stolen = await session();
    const mine = await session();
    await change(mine.accessToken, { currentPassword: f.password, newPassword: NEW_PASSWORD }).expect(201);

    expect((await me(stolen.accessToken)).status).toBe(401);
    expect((await me(mine.accessToken)).status).toBe(401);
    const refresh = await request(baseUrl).post('/v1/auth/refresh').send({ refreshToken: stolen.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('registra data da troca, derruba a versão do token e audita SEM a senha', async () => {
    const before = (await client.query('SELECT token_version FROM users WHERE id = $1', [f.managerId])).rows[0];
    const s = await session();
    await change(s.accessToken, { currentPassword: f.password, newPassword: NEW_PASSWORD }).expect(201);

    const after = (await client.query('SELECT token_version, password_updated_at, failed_login_count FROM users WHERE id = $1', [f.managerId])).rows[0];
    expect(after.token_version).toBe(before.token_version + 1);
    expect(after.password_updated_at).not.toBeNull();
    expect(after.failed_login_count).toBe(0);

    const revoked = await client.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_reason = 'PASSWORD_CHANGED'`, [f.managerId]);
    expect(revoked.rows[0].n).toBeGreaterThanOrEqual(1);

    const audit = await client.query(`SELECT metadata::text AS m FROM audit_logs WHERE action = 'auth.password_changed'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].m).not.toContain(NEW_PASSWORD);
    expect(audit.rows[0].m).not.toContain(f.password);

    const stored = (await client.query('SELECT password_hash FROM users WHERE id = $1', [f.managerId])).rows[0].password_hash as string;
    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(stored).not.toContain(NEW_PASSWORD);
  });

  it('senha atual errada: recusa, não troca nada e conta como tentativa', async () => {
    const s = await session();
    const res = await change(s.accessToken, { currentPassword: 'senha-errada-qualquer', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SENHA_ATUAL_INCORRETA');
    expect((await login(f.password)).status).toBe(201);
    expect((await login(NEW_PASSWORD)).status).toBe(401);
    const row = (await client.query('SELECT failed_login_count FROM users WHERE id = $1', [f.managerId])).rows[0];
    expect(row.failed_login_count).toBeGreaterThanOrEqual(1);
  });

  it('adivinhar a senha atual com um token roubado trava a conta após 5 erros', async () => {
    const s = await session();
    for (let i = 0; i < 5; i++) {
      const res = await change(s.accessToken, { currentPassword: `chute-${i}`, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(422);
    }
    // Agora até a senha CERTA é recusada enquanto durar o bloqueio.
    const locked = await change(s.accessToken, { currentPassword: f.password, newPassword: NEW_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('MUITAS_TENTATIVAS');
    expect((await login(f.password)).status).toBe(401);
  });

  it.each([
    ['curta demais', 'curta123', 'SENHA_FRACA'],
    ['11 caracteres (limite é 12)', 'abcdefghijk', 'SENHA_FRACA'],
    ['a senha publicada no README', DEFAULT_ADMIN_PASSWORD, 'SENHA_FRACA'],
  ])('recusa senha %s', async (_name, newPassword, code) => {
    const s = await session();
    const res = await change(s.accessToken, { currentPassword: f.password, newPassword });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe(code);
    expect((await login(f.password)).status).toBe(201);
  });

  it('aceita exatamente 12 caracteres', async () => {
    const s = await session();
    expect((await change(s.accessToken, { currentPassword: f.password, newPassword: 'abcdefghijkl' })).status).toBe(201);
  });

  it('recusa nova senha igual à atual', async () => {
    const s = await session();
    const res = await change(s.accessToken, { currentPassword: f.password, newPassword: f.password });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SENHA_IGUAL');
  });

  it('recusa senha acima de 128 caracteres e corpo com campos a mais', async () => {
    const s = await session();
    expect((await change(s.accessToken, { currentPassword: f.password, newPassword: 'a'.repeat(129) })).status).toBe(400);
    expect((await change(s.accessToken, { currentPassword: f.password, newPassword: NEW_PASSWORD, role: 'ADMIN' })).status).toBe(400);
    expect((await change(s.accessToken, { currentPassword: f.password })).status).toBe(400);
  });

  it('sem login: 401. Cliente (sem senha): 403', async () => {
    expect((await request(baseUrl).post('/v1/auth/password').send({ currentPassword: 'x', newPassword: NEW_PASSWORD })).status).toBe(401);

    const phone = '+5584977776666';
    await seedCustomer(client, phone);
    const { OtpDeliveryService } = await import('../src/modules/auth/otp-delivery.service.js');
    await request(baseUrl).post('/v1/auth/otp/request').send({ phone });
    const code = app.get(OtpDeliveryService).getDevCode(phone)!;
    const token = (await request(baseUrl).post('/v1/auth/otp/verify').send({ phone, code })).body.accessToken as string;
    expect((await change(token, { currentPassword: 'x', newPassword: NEW_PASSWORD })).status).toBe(403);
  });

  it('só troca a senha de QUEM está logado: a de outro usuário da mesma loja não muda', async () => {
    const s = await session();
    await change(s.accessToken, { currentPassword: f.password, newPassword: NEW_PASSWORD }).expect(201);
    expect((await login(f.password, f.operatorEmail)).status).toBe(201);
  });
});
