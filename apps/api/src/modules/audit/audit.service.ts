import { Injectable } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';
import { createHash } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as s from '../../db/schema.js';
import type { Principal } from '../../common/principal.js';

export interface AuditInput {
  principal?: Principal | null;
  organizationId: string | null;
  branchId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  result?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Campos que NUNCA podem entrar em metadata, mesmo por engano. */
const REDACTED_KEYS = new Set([
  'password',
  'senha',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'pixKey',
  'chavePix',
  'key',
  'secret',
  'cpf',
  'cnpj',
  'authorization',
]);

/**
 * Serialização canônica: chaves ordenadas, recursivamente.
 *
 * JSON.stringify comum NÃO serve para hash: o PostgreSQL normaliza a ordem das
 * chaves ao gravar JSONB, então o objeto relido tem ordem diferente do que foi
 * gravado e o hash recalculado não bate — a cadeia acusaria adulteração onde
 * não houve. Ordenar as chaves torna a serialização independente da ordem.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) ? '[REDIGIDO]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * Trilha de auditoria imutável e encadeada por hash.
 *
 * `record_hash = SHA-256(prev_hash ‖ conteúdo canônico)`, por organização.
 * Alterar ou remover um registro quebra a cadeia de forma detectável — inclusive
 * por quem tem acesso direto ao banco. UPDATE e DELETE são bloqueados por
 * trigger E pela revogação do privilégio para o papel app_user.
 *
 * A escrita acontece na MESMA transação do fato: não existe operação sensível
 * sem trilha.
 */
@Injectable()
export class AuditService {
  async record(tx: Db, input: AuditInput): Promise<void> {
    // Trava por organização, válida até o fim da transação.
    //
    // Sem ela, duas transações concorrentes da mesma organização leriam o MESMO
    // prev_hash e criariam uma BIFURCAÇÃO na cadeia — que o verificador
    // reportaria como adulteração, gerando alarme falso e, pior, escondendo
    // adulteração real no ruído. A trava é curta e por tenant.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.organizationId ?? 'platform'}))`,
    );

    const prev = await tx
      .select({ hash: s.auditLogs.recordHash })
      .from(s.auditLogs)
      .where(
        input.organizationId
          ? eq(s.auditLogs.organizationId, input.organizationId)
          : sql`organization_id IS NULL`,
      )
      // created_at é o instante de INÍCIO da transação: dois registros da mesma
      // transação têm o mesmo valor. O desempate por id é estável porque os IDs
      // são UUIDv7, ordenáveis no tempo (ADR-0010).
      .orderBy(desc(s.auditLogs.createdAt), desc(s.auditLogs.id))
      .limit(1);

    const prevHash = prev[0]?.hash ?? null;
    const metadata = redact(input.metadata ?? {}) as Record<string, unknown>;

    const canonical = canonicalJson({
      organizationId: input.organizationId,
      branchId: input.branchId ?? null,
      actorUserId: input.principal?.userId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      result: input.result ?? 'SUCCESS',
      metadata,
    });

    const recordHash = createHash('sha256')
      .update(prevHash ?? Buffer.alloc(0))
      .update(canonical)
      .digest();

    await tx.insert(s.auditLogs).values({
      id: uuidv7(),
      organizationId: input.organizationId,
      branchId: input.branchId ?? null,
      actorUserId: input.principal?.userId ?? null,
      actorType: input.principal?.userType === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF',
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      result: input.result ?? 'SUCCESS',
      ipAddress: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      metadata,
      prevHash,
      recordHash,
    } as never);
  }

  /** Verificação da cadeia — roda como job diário e no CI. */
  async verifyChain(tx: Db, organizationId: string): Promise<{ ok: boolean; brokenAt?: string }> {
    const rows = await tx
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.organizationId, organizationId))
      .orderBy(s.auditLogs.createdAt, s.auditLogs.id);

    let expectedPrev: Buffer | null = null;
    for (const row of rows) {
      const prevHash = row.prevHash ? Buffer.from(row.prevHash) : null;
      if (
        (expectedPrev === null) !== (prevHash === null) ||
        (expectedPrev && prevHash && !expectedPrev.equals(prevHash))
      ) {
        return { ok: false, brokenAt: row.id };
      }

      const canonical = canonicalJson({
        organizationId: row.organizationId,
        branchId: row.branchId,
        actorUserId: row.actorUserId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        result: row.result,
        metadata: row.metadata,
      });
      const computed = createHash('sha256')
        .update(prevHash ?? Buffer.alloc(0))
        .update(canonical)
        .digest();

      if (!computed.equals(Buffer.from(row.recordHash))) {
        return { ok: false, brokenAt: row.id };
      }
      expectedPrev = computed;
    }
    return { ok: true };
  }
}
