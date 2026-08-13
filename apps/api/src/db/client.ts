import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/**
 * Contexto de tenant aplicado a cada transação.
 * É o que alimenta as políticas de RLS (migrations/0003_rls.sql).
 */
export interface TenantContext {
  readonly userId: string | null;
  readonly userType: 'STAFF' | 'CUSTOMER' | 'NONE';
  readonly organizationId: string | null;
  /** Unidades em escopo. Lista vazia = toda a organização (FRANCHISE_ADMIN). */
  readonly branchScope: readonly string[];
  readonly isPlatformAdmin: boolean;
}

export const ANONYMOUS_CONTEXT: TenantContext = {
  userId: null,
  userType: 'NONE',
  organizationId: null,
  branchScope: [],
  isPlatformAdmin: false,
};

// `pg` devolve BIGINT como string para não perder precisão. Nossos valores
// monetários cabem com folga em Number (centavos até ~90 trilhões de reais),
// e o pacote domain trabalha com number — então convertemos na borda.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number.parseFloat(value));

@Injectable()
export class Database implements OnModuleDestroy {
  private readonly pool: pg.Pool;
  /** Acesso sem RLS — usado apenas por migrações e pelo fluxo de identidade. */
  readonly platform: Db;

  constructor() {
    // Sem parâmetro: um construtor com argumento opcional e valor padrão é
    // ambíguo para o DI do Nest — dependendo de como os metadados de decorador
    // são emitidos (esbuild, usado por tsx, não os emite; `tsc` emite, mas o
    // parâmetro sem anotação de tipo vira `Object`), o container tenta
    // injetar um token que não existe. Lendo o valor direto no corpo, o
    // construtor fica com zero parâmetros e nada para o Nest resolver aqui.
    const connectionString = loadEnv().DATABASE_URL;
    this.pool = new pg.Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.platform = drizzle(this.pool, { schema });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Executa `fn` dentro de uma transação com o contexto de tenant aplicado.
   *
   * Dois pontos essenciais:
   *
   * 1. `SET LOCAL ROLE app_user` — a aplicação nunca opera como dono das
   *    tabelas nem como superusuário, porque ambos IGNORAM RLS por padrão.
   *    Sem esta linha, todo o arquivo 0003_rls.sql seria decorativo.
   *
   * 2. `SET LOCAL` vale até o COMMIT/ROLLBACK, o que torna o padrão seguro
   *    com PgBouncer em modo transaction.
   *
   * Isolamento READ COMMITTED é obrigatório para a reserva atômica de estoque
   * (ver docs/05 §3): em REPEATABLE READ o UPDATE condicional levantaria erro
   * de serialização em vez de reavaliar a cláusula WHERE.
   */
  async withTenant<T>(ctx: TenantContext, fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.platform.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.user_id', ${ctx.userId ?? ''}, true),
                     set_config('app.user_type', ${ctx.userType}, true),
                     set_config('app.organization_id', ${ctx.organizationId ?? ''}, true),
                     set_config('app.branch_scope', ${ctx.branchScope.join(',')}, true),
                     set_config('app.is_platform_admin', ${ctx.isPlatformAdmin ? 'on' : 'off'}, true)`,
        );
        return fn(tx);
      },
      { isolationLevel: 'read committed' },
    );
  }

  /**
   * Transação SEM RLS. Reservada a:
   *  - migrações;
   *  - fluxo de autenticação (precisa ler o usuário antes de haver identidade);
   *  - workers de plataforma (outbox, expiração de reservas).
   * Todo uso é auditado e revisado — não é atalho para contornar isolamento.
   */
  async withPlatform<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.platform.transaction(fn, { isolationLevel: 'read committed' });
  }

  async raw(query: string, params: unknown[] = []): Promise<pg.QueryResult> {
    return this.pool.query(query, params as never[]);
  }
}
