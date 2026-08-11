import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, type INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import express from 'express';
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
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
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
  return app;
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await createApp();
  app.get(SchedulerService).start();
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API ouvindo na porta ${env.PORT}`);
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
