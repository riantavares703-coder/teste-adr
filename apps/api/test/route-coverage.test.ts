import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { INestApplication, Type } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY, PUBLIC_KEY } from '../src/common/principal.js';
import { AppModule } from '../src/app.module.js';
import { createTestApp, setupDatabase } from './helpers/harness.js';

/**
 * A lista de controllers vem do PRÓPRIO módulo, por metadado.
 *
 * Antes era uma lista escrita à mão neste arquivo — o que abria um buraco no
 * teste que ele existe para fechar: um controller novo, registrado no
 * AppModule mas esquecido aqui, passaria sem nunca ter as rotas conferidas.
 * Lendo do AppModule, entrar no ar e entrar na verificação viram o mesmo ato.
 */
const CONTROLLERS: Type<unknown>[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) ?? [];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

interface RouteInfo {
  controller: string;
  handler: string;
  method: string;
  path: string;
  permission?: string;
  isPublic: boolean;
}

function enumerateRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const controller of CONTROLLERS) {
    const basePath = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
    const prototype = controller.prototype as unknown as Record<string, unknown>;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;

      const path = Reflect.getMetadata(PATH_METADATA, handler);
      if (path === undefined) continue;

      routes.push({
        controller: controller.name,
        handler: name,
        method: METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '?',
        path: `/${basePath}/${path}`.replace(/\/+/g, '/'),
        permission: Reflect.getMetadata(PERMISSION_KEY, handler),
        isPublic: Reflect.getMetadata(PUBLIC_KEY, handler) === true,
      });
    }
  }

  return routes;
}

/**
 * NEGAR POR PADRÃO, verificado estruturalmente.
 *
 * O AuthGuard rejeita em tempo de execução qualquer rota sem `@RequirePermission`
 * nem `@Public`. Este teste antecipa isso para o CI: esquecer de proteger um
 * endpoint deixa de ser um bug descoberto em produção e passa a ser um build
 * quebrado.
 */
describe('Cobertura de autorização das rotas', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await setupDatabase();
    ({ app } = await createTestApp());
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  it('enxerga todos os controllers do módulo', () => {
    // Se a leitura de metadado quebrar numa atualização do Nest, a lista fica
    // vazia e os testes seguintes passariam por vacuidade. Esta asserção é a
    // trava contra "verde por não ter olhado nada".
    expect(CONTROLLERS.length).toBeGreaterThanOrEqual(8);
    expect(enumerateRoutes().length).toBeGreaterThan(20);
  });

  it('TODA rota declara @RequirePermission ou @Public', () => {
    const undeclared = enumerateRoutes()
      .filter((r) => !r.isPublic && r.permission === undefined)
      .map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`);

    expect(undeclared, `Rotas sem declaração de autorização:\n${undeclared.join('\n')}`).toEqual([]);
  });

  it('nenhuma rota é pública E protegida ao mesmo tempo', () => {
    const ambiguous = enumerateRoutes()
      .filter((r) => r.isPublic && r.permission !== undefined)
      .map((r) => `${r.method} ${r.path}`);
    expect(ambiguous).toEqual([]);
  });

  it('as rotas públicas são apenas as esperadas (vitrine e autenticação)', () => {
    const publicRoutes = enumerateRoutes()
      .filter((r) => r.isPublic)
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    // Lista fechada: qualquer rota nova que se declare pública precisa passar
    // por aqui — e por uma revisão consciente.
    expect(publicRoutes).toEqual([
      'GET /v1/auth/me',
      'GET /v1/media/:storageKey',
      'GET /v1/public/:organizationSlug/:branchSlug/menu',
      'GET /v1/public/:organizationSlug/branches',
      'GET /v1/public/products/:id',
      'POST /v1/auth/login',
      'POST /v1/auth/otp/request',
      'POST /v1/auth/otp/verify',
      'POST /v1/auth/refresh',
    ]);
  });

  it('toda permissão exigida existe no catálogo de permissões', async () => {
    const { Database } = await import('../src/db/client.js');
    const db = app.get(Database);
    const { rows } = await db.raw('SELECT code FROM permissions');
    const known = new Set(rows.map((r: { code: string }) => r.code));

    const unknown = enumerateRoutes()
      .map((r) => r.permission)
      .filter((p): p is string => Boolean(p))
      .filter((p) => !known.has(p));

    expect([...new Set(unknown)]).toEqual([]);
  });

  it('rotas de escrita em recurso de unidade carregam branchId no caminho', () => {
    const writeRoutes = enumerateRoutes().filter(
      (r) =>
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) &&
        !r.isPublic &&
        !r.path.startsWith('/v1/auth') &&
        !r.path.startsWith('/v1/orders'),
    );
    const missing = writeRoutes.filter((r) => !r.path.includes(':branchId'));
    expect(missing.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});
