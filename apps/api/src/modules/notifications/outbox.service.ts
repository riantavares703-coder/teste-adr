import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';

import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';

export interface DomainEvent {
  organizationId: string | null;
  branchId: string | null;
  aggregateType: 'order' | 'payment' | 'inventory';
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Transactional Outbox (ADR-0007).
 *
 * O evento é gravado na MESMA transação do fato de negócio. Isso resolve o
 * dual write: nunca existe pedido sem evento nem evento sem pedido.
 *
 * Consequência direta do requisito do briefing — "se a API do WhatsApp estiver
 * indisponível, o pedido continuará funcionando normalmente": a criação do
 * pedido não faz NENHUMA chamada externa. Ela grava e comita; o relay entrega
 * depois, com retry.
 */
@Injectable()
export class OutboxService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async publish(tx: Db, event: DomainEvent): Promise<void> {
    await tx.insert(s.outboxEvents).values({
      id: uuidv7(),
      organizationId: event.organizationId,
      branchId: event.branchId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
    } as never);
  }

  /**
   * Reserva um lote de eventos pendentes para processamento.
   * `FOR UPDATE SKIP LOCKED` permite vários relays em paralelo sem que dois
   * peguem o mesmo evento.
   */
  async claimPending(limit = 50): Promise<
    Array<{
      id: string;
      organization_id: string | null;
      branch_id: string | null;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>
  > {
    const result = await this.db.platform.execute(sql`
      WITH claimed AS (
        SELECT id FROM outbox_events
         WHERE published_at IS NULL AND next_attempt_at <= now()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE outbox_events o
         SET attempts = o.attempts + 1
        FROM claimed c
       WHERE o.id = c.id
      RETURNING o.id, o.organization_id, o.branch_id, o.aggregate_type,
                o.aggregate_id, o.event_type, o.payload, o.attempts
    `);
    return result.rows as never;
  }

  async markPublished(id: string): Promise<void> {
    await this.db.platform.execute(
      sql`UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = ${id}`,
    );
  }

  /** Backoff exponencial com jitter; após 5 tentativas o evento vai para a DLQ. */
  async markFailed(id: string, attempts: number, error: string): Promise<void> {
    const backoffSeconds = Math.min(2 ** attempts * 5, 900);
    const jitter = Math.floor(Math.random() * backoffSeconds * 0.2);
    await this.db.platform.execute(sql`
      UPDATE outbox_events
         SET last_error = ${error.slice(0, 1000)},
             next_attempt_at = now() + make_interval(secs => ${backoffSeconds + jitter})
       WHERE id = ${id}
    `);
  }

  async pendingCount(): Promise<number> {
    const result = await this.db.platform.execute(
      sql`SELECT count(*)::int AS count FROM outbox_events WHERE published_at IS NULL`,
    );
    return (result.rows[0] as { count: number }).count;
  }
}
