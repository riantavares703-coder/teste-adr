import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';

import { and, eq, sql } from 'drizzle-orm';
import { resolveAvailability, type AvailabilityView } from '@plataforma/domain';
import type { Db } from '../../db/client.js';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { conflict, notFound } from '../../common/errors.js';
import type { Principal } from '../../common/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../notifications/outbox.service.js';

export interface ReservationRequest {
  readonly productId: string;
  readonly quantity: number;
}

export interface InventoryRow {
  id: string;
  productId: string;
  productName: string;
  mode: 'INFINITE' | 'LIMITED';
  onHandQty: number;
  reservedQty: number;
  isManuallySoldOut: boolean;
  soldOutAt: Date | null;
  soldOutByName: string | null;
  lowStockThreshold: number | null;
  availability: AvailabilityView;
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  // ===========================================================================
  // RESERVA ATÔMICA — o coração da proteção contra overselling
  // ===========================================================================

  /**
   * Reserva estoque para um pedido, dentro da transação do checkout.
   *
   * A garantia vem de UM ÚNICO statement por item:
   *
   *   UPDATE ... SET reserved_qty = reserved_qty + n
   *    WHERE ... AND (on_hand_qty - reserved_qty) >= n
   *
   * Em READ COMMITTED, quando duas transações atualizam a MESMA linha, a
   * segunda bloqueia até a primeira comitar e então REAVALIA a cláusula WHERE
   * contra a versão nova da linha (EvalPlanQual). Se o estoque acabou nesse
   * intervalo, o WHERE fica falso e o UPDATE afeta zero linhas.
   *
   * O anti-padrão que isso evita é decidir FORA do banco:
   *   SELECT disponivel  ->  aplicação decide "tem estoque"  ->  UPDATE
   * Ambas as transações leriam 1 e ambas gravariam: duas vendas, uma unidade.
   *
   * Itens são processados em ordem crescente de product_id: ordem total
   * consistente torna deadlock impossível entre dois pedidos concorrentes com
   * os mesmos produtos em ordens diferentes.
   */
  async reserveForOrder(
    tx: Db,
    input: {
      orderId: string;
      organizationId: string;
      branchId: string;
      items: readonly ReservationRequest[];
      expiresAt: Date;
      actorUserId: string;
    },
  ): Promise<void> {
    const ordered = [...input.items].sort((a, b) => a.productId.localeCompare(b.productId));

    for (const item of ordered) {
      const updated = await tx.execute(sql`
        UPDATE virtual_inventory
           SET reserved_qty = reserved_qty + ${item.quantity},
               updated_at   = now()
         WHERE branch_id  = ${input.branchId}
           AND product_id = ${item.productId}
           AND mode = 'LIMITED'
           AND is_manually_sold_out = false
           AND (on_hand_qty - reserved_qty) >= ${item.quantity}
        RETURNING id, on_hand_qty, reserved_qty
      `);

      if (updated.rows.length === 0) {
        // Ou o produto é INFINITE (nada a reservar), ou não há estoque.
        // A distinção precisa ser feita: só a segunda é erro.
        const current = await tx
          .select()
          .from(s.virtualInventory)
          .where(
            and(
              eq(s.virtualInventory.branchId, input.branchId),
              eq(s.virtualInventory.productId, item.productId),
            ),
          )
          .limit(1);

        const inv = current[0];
        if (!inv) throw notFound('PRODUTO_SEM_ESTOQUE', 'Produto sem registro de disponibilidade');

        if (inv.mode === 'INFINITE' && !inv.isManuallySoldOut) continue;

        const view = resolveAvailability({
          mode: inv.mode,
          onHandQty: inv.onHandQty,
          reservedQty: inv.reservedQty,
          isManuallySoldOut: inv.isManuallySoldOut,
        });

        throw conflict('PRODUTO_INDISPONIVEL', 'Produto indisponível na quantidade solicitada', {
          productId: item.productId,
          requested: item.quantity,
          available: view.availableQuantity,
          status: view.status,
        });
      }

      const row = updated.rows[0] as { id: string; on_hand_qty: number; reserved_qty: number };

      await tx.insert(s.inventoryReservations).values({
        id: uuidv7(),
        organizationId: input.organizationId,
        branchId: input.branchId,
        orderId: input.orderId,
        virtualInventoryId: row.id,
        quantity: item.quantity,
        status: 'ACTIVE',
        expiresAt: input.expiresAt,
      } as never);

      await this.recordMovement(tx, {
        organizationId: input.organizationId,
        branchId: input.branchId,
        virtualInventoryId: row.id,
        productId: item.productId,
        type: 'RESERVE',
        quantityDelta: item.quantity,
        onHandAfter: row.on_hand_qty,
        reservedAfter: row.reserved_qty,
        orderId: input.orderId,
        actorUserId: input.actorUserId,
        actorType: 'CUSTOMER',
      });
    }
  }

  /**
   * Confirma as reservas de um pedido: a unidade sai de vez do estoque.
   * `reserved_qty >= n` torna a operação idempotente — rodar duas vezes por
   * engano (retry de worker) não produz número negativo.
   */
  async commitReservations(tx: Db, orderId: string, actorUserId: string | null): Promise<void> {
    const reservations = await tx
      .select()
      .from(s.inventoryReservations)
      .where(
        and(
          eq(s.inventoryReservations.orderId, orderId),
          eq(s.inventoryReservations.status, 'ACTIVE'),
        ),
      );

    for (const r of reservations) {
      const updated = await tx.execute(sql`
        UPDATE virtual_inventory
           SET on_hand_qty  = on_hand_qty  - ${r.quantity},
               reserved_qty = reserved_qty - ${r.quantity},
               updated_at   = now()
         WHERE id = ${r.virtualInventoryId}
           AND reserved_qty >= ${r.quantity}
        RETURNING product_id, on_hand_qty, reserved_qty
      `);
      if (updated.rows.length === 0) continue;

      const row = updated.rows[0] as {
        product_id: string;
        on_hand_qty: number;
        reserved_qty: number;
      };

      await tx
        .update(s.inventoryReservations)
        .set({ status: 'COMMITTED', resolvedAt: new Date() })
        .where(eq(s.inventoryReservations.id, r.id));

      await this.recordMovement(tx, {
        organizationId: r.organizationId,
        branchId: r.branchId,
        virtualInventoryId: r.virtualInventoryId,
        productId: row.product_id,
        type: 'COMMIT',
        quantityDelta: -r.quantity,
        onHandAfter: row.on_hand_qty,
        reservedAfter: row.reserved_qty,
        orderId,
        actorUserId,
        actorType: actorUserId ? 'STAFF' : 'SYSTEM',
      });
    }
  }

  /** Libera reservas (cancelamento ou expiração) — o estoque volta a circular. */
  async releaseReservations(
    tx: Db,
    orderId: string,
    reason: 'RELEASE' | 'EXPIRE_RELEASE',
    actorUserId: string | null,
  ): Promise<void> {
    const reservations = await tx
      .select()
      .from(s.inventoryReservations)
      .where(
        and(
          eq(s.inventoryReservations.orderId, orderId),
          eq(s.inventoryReservations.status, 'ACTIVE'),
        ),
      );

    for (const r of reservations) {
      const updated = await tx.execute(sql`
        UPDATE virtual_inventory
           SET reserved_qty = reserved_qty - ${r.quantity},
               updated_at   = now()
         WHERE id = ${r.virtualInventoryId}
           AND reserved_qty >= ${r.quantity}
        RETURNING product_id, on_hand_qty, reserved_qty
      `);
      if (updated.rows.length === 0) continue;

      const row = updated.rows[0] as {
        product_id: string;
        on_hand_qty: number;
        reserved_qty: number;
      };

      await tx
        .update(s.inventoryReservations)
        .set({
          status: reason === 'EXPIRE_RELEASE' ? 'EXPIRED' : 'RELEASED',
          resolvedAt: new Date(),
        })
        .where(eq(s.inventoryReservations.id, r.id));

      await this.recordMovement(tx, {
        organizationId: r.organizationId,
        branchId: r.branchId,
        virtualInventoryId: r.virtualInventoryId,
        productId: row.product_id,
        type: reason,
        quantityDelta: -r.quantity,
        onHandAfter: row.on_hand_qty,
        reservedAfter: row.reserved_qty,
        orderId,
        actorUserId,
        actorType: actorUserId ? 'STAFF' : 'SYSTEM',
      });
    }
  }

  // ===========================================================================
  // Operações do operador
  // ===========================================================================

  /** Painel de estoque: Produto | Disponível | Status (item 3 do Prompt 02). */
  async listForBranch(principal: Principal, branchId: string): Promise<InventoryRow[]> {
    return this.db.withTenant(this.ctx(principal), async (tx) => {
      const rows = await tx
        .select({
          inv: s.virtualInventory,
          productName: s.products.name,
          soldOutByName: sql<string | null>`sold_out_user.full_name`,
        })
        .from(s.virtualInventory)
        .innerJoin(s.products, eq(s.products.id, s.virtualInventory.productId))
        .leftJoin(
          sql`users AS sold_out_user`,
          sql`sold_out_user.id = ${s.virtualInventory.soldOutBy}`,
        )
        .where(
          and(eq(s.virtualInventory.branchId, branchId), sql`${s.products.deletedAt} IS NULL`),
        )
        .orderBy(s.products.position, s.products.name);

      return rows.map(({ inv, productName, soldOutByName }) => ({
        id: inv.id,
        productId: inv.productId,
        productName,
        mode: inv.mode,
        onHandQty: inv.onHandQty,
        reservedQty: inv.reservedQty,
        isManuallySoldOut: inv.isManuallySoldOut,
        soldOutAt: inv.soldOutAt,
        soldOutByName,
        lowStockThreshold: inv.lowStockThreshold,
        availability: resolveAvailability({
          mode: inv.mode,
          onHandQty: inv.onHandQty,
          reservedQty: inv.reservedQty,
          isManuallySoldOut: inv.isManuallySoldOut,
        }),
      }));
    });
  }

  /**
   * [ ESGOTAR ] — marca o produto como indisponível.
   *
   * Independente da quantidade: "acabou a maionese" não é o mesmo fato que
   * "cheguei a zero". Separar preserva o número para quando o operador
   * reativar, e mantém a distinção na auditoria.
   */
  async markSoldOut(
    principal: Principal,
    branchId: string,
    productId: string,
    reason?: string,
  ): Promise<InventoryRow> {
    return this.setSoldOut(principal, branchId, productId, true, reason);
  }

  /** [ REATIVAR ] */
  async reactivate(
    principal: Principal,
    branchId: string,
    productId: string,
  ): Promise<InventoryRow> {
    return this.setSoldOut(principal, branchId, productId, false);
  }

  private async setSoldOut(
    principal: Principal,
    branchId: string,
    productId: string,
    soldOut: boolean,
    reason?: string,
  ): Promise<InventoryRow> {
    const result = await this.db.withTenant(this.ctx(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.virtualInventory)
        .where(
          and(
            eq(s.virtualInventory.branchId, branchId),
            eq(s.virtualInventory.productId, productId),
          ),
        )
        .limit(1);

      const inv = rows[0];
      // RLS já filtrou por tenant: se não veio, não existe PARA ESTE ator.
      if (!inv) throw notFound();

      const now = new Date();
      const updated = await tx
        .update(s.virtualInventory)
        .set(
          soldOut
            ? { isManuallySoldOut: true, soldOutBy: principal.userId, soldOutAt: now }
            : { isManuallySoldOut: false, reactivatedBy: principal.userId, reactivatedAt: now },
        )
        .where(eq(s.virtualInventory.id, inv.id))
        .returning();

      const next = updated[0]!;

      await this.recordMovement(tx, {
        organizationId: inv.organizationId,
        branchId,
        virtualInventoryId: inv.id,
        productId,
        type: soldOut ? 'SOLD_OUT_MANUAL' : 'REACTIVATE',
        quantityDelta: 0,
        onHandAfter: next.onHandQty,
        reservedAfter: next.reservedQty,
        orderId: null,
        actorUserId: principal.userId,
        actorType: 'STAFF',
        reason: reason ?? null,
      });

      await this.audit.record(tx, {
        principal,
        organizationId: inv.organizationId,
        branchId,
        action: soldOut ? 'inventory.marked_sold_out' : 'inventory.reactivated',
        resourceType: 'virtual_inventory',
        resourceId: inv.id,
        metadata: { productId, reason: reason ?? null },
      });

      await this.outbox.publish(tx, {
        organizationId: inv.organizationId,
        branchId,
        aggregateType: 'inventory',
        aggregateId: inv.id,
        eventType: soldOut ? 'inventory.sold_out' : 'inventory.reactivated',
        payload: { productId, branchId },
      });

      return next;
    });

    return this.toRow(result, productId);
  }

  /** [ +1 ] [ +5 ] [ +10 ] e ajuste manual com motivo. */
  async adjustQuantity(
    principal: Principal,
    branchId: string,
    productId: string,
    delta: number,
    reason?: string,
  ): Promise<InventoryRow> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw conflict('AJUSTE_INVALIDO', 'O ajuste deve ser um inteiro diferente de zero');
    }

    const result = await this.db.withTenant(this.ctx(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.virtualInventory)
        .where(
          and(
            eq(s.virtualInventory.branchId, branchId),
            eq(s.virtualInventory.productId, productId),
          ),
        )
        .limit(1);
      const inv = rows[0];
      if (!inv) throw notFound();

      // Ajustar quantidade implica controlar quantidade.
      const updated = await tx.execute(sql`
        UPDATE virtual_inventory
           SET on_hand_qty = on_hand_qty + ${delta},
               mode = 'LIMITED',
               updated_at = now()
         WHERE id = ${inv.id}
           AND on_hand_qty + ${delta} >= reserved_qty
           AND on_hand_qty + ${delta} >= 0
        RETURNING on_hand_qty, reserved_qty
      `);

      if (updated.rows.length === 0) {
        throw conflict(
          'AJUSTE_ABAIXO_DO_RESERVADO',
          'O ajuste deixaria o estoque abaixo do que já está reservado',
          { onHand: inv.onHandQty, reserved: inv.reservedQty, delta },
        );
      }

      const row = updated.rows[0] as { on_hand_qty: number; reserved_qty: number };

      await this.recordMovement(tx, {
        organizationId: inv.organizationId,
        branchId,
        virtualInventoryId: inv.id,
        productId,
        type: delta > 0 ? 'RESTOCK' : 'MANUAL_ADJUST',
        quantityDelta: delta,
        onHandAfter: row.on_hand_qty,
        reservedAfter: row.reserved_qty,
        orderId: null,
        actorUserId: principal.userId,
        actorType: 'STAFF',
        reason: reason ?? null,
      });

      await this.audit.record(tx, {
        principal,
        organizationId: inv.organizationId,
        branchId,
        action: 'inventory.adjusted',
        resourceType: 'virtual_inventory',
        resourceId: inv.id,
        metadata: { productId, delta, onHandAfter: row.on_hand_qty, reason: reason ?? null },
      });

      await this.outbox.publish(tx, {
        organizationId: inv.organizationId,
        branchId,
        aggregateType: 'inventory',
        aggregateId: inv.id,
        eventType: 'inventory.adjusted',
        payload: { productId, branchId, onHandAfter: row.on_hand_qty },
      });

      return {
        ...inv,
        mode: 'LIMITED' as const,
        onHandQty: row.on_hand_qty,
        reservedQty: row.reserved_qty,
      };
    });

    return this.toRow(result, productId);
  }

  /** Define o modo de controle (ilimitado x quantidade). */
  async setMode(
    principal: Principal,
    branchId: string,
    productId: string,
    mode: 'INFINITE' | 'LIMITED',
    initialQuantity?: number,
  ): Promise<InventoryRow> {
    const result = await this.db.withTenant(this.ctx(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.virtualInventory)
        .where(
          and(
            eq(s.virtualInventory.branchId, branchId),
            eq(s.virtualInventory.productId, productId),
          ),
        )
        .limit(1);
      const inv = rows[0];
      if (!inv) throw notFound();

      const nextOnHand =
        mode === 'LIMITED' && initialQuantity !== undefined ? initialQuantity : inv.onHandQty;

      if (nextOnHand < inv.reservedQty) {
        throw conflict(
          'QUANTIDADE_ABAIXO_DO_RESERVADO',
          'A quantidade informada é menor que o já reservado',
        );
      }

      const updated = await tx
        .update(s.virtualInventory)
        .set({ mode, onHandQty: nextOnHand })
        .where(eq(s.virtualInventory.id, inv.id))
        .returning();

      await this.audit.record(tx, {
        principal,
        organizationId: inv.organizationId,
        branchId,
        action: 'inventory.mode_changed',
        resourceType: 'virtual_inventory',
        resourceId: inv.id,
        metadata: { productId, mode, onHand: nextOnHand },
      });

      return updated[0]!;
    });

    return this.toRow(result, productId);
  }

  // ===========================================================================

  private async recordMovement(
    tx: Db,
    input: {
      organizationId: string;
      branchId: string;
      virtualInventoryId: string;
      productId: string;
      type:
        | 'RESERVE'
        | 'COMMIT'
        | 'RELEASE'
        | 'EXPIRE_RELEASE'
        | 'MANUAL_ADJUST'
        | 'RESTOCK'
        | 'SOLD_OUT_MANUAL'
        | 'REACTIVATE';
      quantityDelta: number;
      onHandAfter: number;
      reservedAfter: number;
      orderId: string | null;
      actorUserId: string | null;
      actorType: 'CUSTOMER' | 'STAFF' | 'SYSTEM';
      reason?: string | null;
    },
  ): Promise<void> {
    await tx.insert(s.inventoryMovements).values({
      id: uuidv7(),
      organizationId: input.organizationId,
      branchId: input.branchId,
      virtualInventoryId: input.virtualInventoryId,
      productId: input.productId,
      type: input.type,
      quantityDelta: input.quantityDelta,
      onHandAfter: input.onHandAfter,
      reservedAfter: input.reservedAfter,
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      actorType: input.actorType,
      reason: input.reason ?? null,
    } as never);
  }

  private toRow(
    inv: {
      id: string;
      mode: 'INFINITE' | 'LIMITED';
      onHandQty: number;
      reservedQty: number;
      isManuallySoldOut: boolean;
      soldOutAt: Date | null;
      lowStockThreshold: number | null;
    },
    productId: string,
  ): InventoryRow {
    return {
      id: inv.id,
      productId,
      productName: '',
      mode: inv.mode,
      onHandQty: inv.onHandQty,
      reservedQty: inv.reservedQty,
      isManuallySoldOut: inv.isManuallySoldOut,
      soldOutAt: inv.soldOutAt,
      soldOutByName: null,
      lowStockThreshold: inv.lowStockThreshold,
      availability: resolveAvailability({
        mode: inv.mode,
        onHandQty: inv.onHandQty,
        reservedQty: inv.reservedQty,
        isManuallySoldOut: inv.isManuallySoldOut,
      }),
    };
  }

  private ctx(principal: Principal) {
    return {
      userId: principal.userId,
      userType: principal.userType,
      organizationId: principal.organizationId,
      branchScope: principal.isOrgWide ? [] : principal.branchScope,
      isPlatformAdmin: principal.isPlatformAdmin,
    };
  }
}
