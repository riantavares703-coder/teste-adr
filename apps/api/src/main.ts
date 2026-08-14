import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, type INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { SchedulerService } from './modules/scheduler/scheduler.service.js';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function createApp(): Promise<INestApplication> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    logger: env.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });

  app.use(
    helmet({
      /**
       * A API passou a servir também os dois SPAs (painel e cardápio), então
       * `defaultSrc: 'none'` deixou de servir: ele bloquearia o próprio bundle
       * da página e o cliente veria uma tela branca.
       *
       * A política continua fechada no que importa — nada de origem externa,
       * nada de `unsafe-eval`, nenhum antepassado de frame — e libera apenas o
       * necessário para uma página servida por este mesmo processo.
       */
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // React injeta estilo inline; sem isto a página renderiza sem CSS.
          styleSrc: ["'self'", "'unsafe-inline'"],
          // `data:`/`blob:` cobrem o QR code gerado no próprio navegador.
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // Este processo nunca serve HTTPS — é um servidor local/LAN puro.
          // O default do Helmet inclui upgrade-insecure-requests, que reescreve
          // TODA requisição http:// (CSS, JS, imagens) para https:// antes de
          // disparar. Em `localhost` isso passa despercebido (o navegador já
          // trata `localhost` como origem confiável e não reescreve nada), mas
          // em qualquer outro host — o IP da rede, o hostname do Wi-Fi — a
          // reescrita aponta para uma porta sem TLS e cada asset cai com
          // ERR_CONNECTION_RESET: a tela fica em branco. Precisa ficar `null`
          // sempre, não só em desenvolvimento.
          upgradeInsecureRequests: null,
        },
      },
      // HSTS também pressupõe HTTPS: ativá-lo aqui não tem efeito (navegadores
      // ignoram o cabeçalho fora de uma conexão segura), mas deixá-lo desligado
      // evita qualquer risco caso este processo um dia rode atrás de um proxy
      // TLS mal configurado.
      hsts: false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Limite de corpo aplicado ANTES de qualquer parsing pesado.
  app.use(express.json({ limit: '256kb' }));

  // Upload de imagem: binário puro, com o limite aplicado antes de decodificar.
  app.use(
    express.raw({
      type: (req) => IMAGE_TYPES.includes(String(req.headers['content-type']).split(';')[0]!),
      limit: env.MEDIA_MAX_BYTES,
    }),
  );
  app.use((req: express.Request & { rawFile?: unknown }, _res: express.Response, next: express.NextFunction) => {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      req.rawFile = {
        buffer: req.body,
        mimetype: String(req.headers['content-type']).split(';')[0],
      };
    }
    next();
  });

  // CORS com origens explícitas. Nunca '*' com credenciais.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean);
  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
    maxAge: 600,
  });

  // Necessário para que req.ip reflita o cliente real atrás do proxy/CDN.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Antes de o Nest registrar suas rotas — ver a explicação em mountWebApps.
  mountWebApps(app);
  return app;
}

/**
 * Serve as duas interfaces a partir DESTE processo.
 *
 * Motivo: o restaurante abre um programa só. Um servidor web separado seria
 * mais uma porta para liberar no firewall, mais um processo para morrer sozinho
 * e mais uma origem para o CORS — sem nenhum ganho numa instalação de balcão.
 *
 * Registrado ANTES das rotas do Nest, e não depois: o Nest instala um
 * tratador final que responde 404 a tudo que suas rotas não reconhecem, então
 * um middleware registrado depois dele nunca seria alcançado. A ordem inversa é
 * segura porque este middleware ignora explicitamente os prefixos da API.
 *
 * Cada SPA tem um `base` próprio no Vite (`/admin/` e `/storefront/`) porque os
 * dois gerariam `/assets/index-*.js` e um sobrescreveria o outro.
 */
export function mountWebApps(app: INestApplication): void {
  const server = app.getHttpAdapter().getInstance();
  const appsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const logger = new Logger('WebApps');
  const quiet = loadEnv().NODE_ENV === 'test';

  const operatorDist = join(appsDir, 'web-operator', 'dist');
  const customerDist = join(appsDir, 'web-customer', 'dist');

  if (existsSync(operatorDist)) {
    server.use('/admin', express.static(operatorDist));
    // Fallback de SPA: recarregar /admin/pedidos precisa devolver o index.
    server.get(/^\/admin(\/.*)?$/, (_req: express.Request, res: express.Response) => {
      res.sendFile(join(operatorDist, 'index.html'));
    });
  } else if (!quiet) {
    logger.warn('Painel do operador não compilado (apps/web-operator/dist ausente)');
  }

  if (existsSync(customerDist)) {
    server.use('/storefront', express.static(customerDist));

    // O cardápio mora em /:organizacao/:unidade e seus subcaminhos
    // (/demo/centro, /demo/centro/carrinho, ...). Em vez de uma expressão que
    // tente descrever todos, a regra é por exclusão: o que não é rota da API
    // nem parece um arquivo é navegação do cardápio.
    const RESERVED = ['/v1', '/admin', '/storefront'];
    server.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET') return next();
      if (RESERVED.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
        return next();
      }
      // Um ponto no último segmento indica arquivo (favicon.ico), não rota.
      if (req.path.split('/').pop()?.includes('.')) return next();
      if (!req.accepts('html')) return next();
      // Precisa de organização E unidade; "/" sozinho não identifica loja.
      if (req.path.split('/').filter(Boolean).length < 2) return next();
      return res.sendFile(join(customerDist, 'index.html'));
    });
  } else if (!quiet) {
    logger.warn('Cardápio não compilado (apps/web-customer/dist ausente)');
  }
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await createApp();
  app.get(SchedulerService).start();
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API ouvindo na porta ${env.PORT}`);
}

// pathToFileURL: no Windows, `file://` + `C:\...` nunca casa com a URL real do
// módulo, e a API subiria sem nunca chamar bootstrap().
const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
