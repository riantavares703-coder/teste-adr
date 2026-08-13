import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ACTIVE_ORDER_STATUSES,
  businessDateFor,
  canTransition,
  formatOrderNumber,
  priceOrder,
  type ActorType,
  type FulfillmentType,
  type OrderStatus,
  type PaymentMethod,
  openState,
  describeOpenState,
  validateModifierSelection,
  type BusinessHour,
  type ModifierRule,
} from '@plataforma/domain';
import { Database, type Db } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { badRequest, conflict, notFound, unprocessable } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OutboxService } from '../notifications/outbox.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

export interface CreateOrderItemInput {
  readonly productId: string;
  readonly quantity: number;
  readonly optionIds?: readonly string[];
  readonly notes?: string;
}

export interface CreateOrderInput {
  readonly branchId: string;
  readonly fulfillment: FulfillmentType;
  readonly paymentMethod: PaymentMethod;
  readonly items: readonly CreateOrderItemInput[];
  readonly deliveryAddressId?: string;
  readonly customerNotes?: string;
  readonly changeForCents?: number;
  /** Comparação apenas. NÃO é usado para cobrar (item 5 do Prompt 02). */
  readonly expectedTotalCents?: number;
}

@Injectable()
export class OrderingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(BranchAccessService) private readonly branchAccess: BranchAccessService,
  ) {}

  // ===========================================================================
  // CHECKOUT
  // ===========================================================================

  /**
   * Cria o pedido em UMA transação: recálculo de preço, reserva de estoque,
   * numeração, persistência, pagamento e eventos.
   *
   * Se a reserva do terceiro item falhar, os dois primeiros são desfeitos pelo
   * ROLLBACK — não existe estado intermediário observável nem estoque preso por
   * um pedido que não nasceu.
   */
  async createOrder(
    principal: Principal,
    input: CreateOrderInput,
    meta: { idempotencyKey: string; ip?: string; requestId?: string },
  ): Promise<{ orderId: string; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ ...input, userId: principal.userId }))
      .digest();

    // --- idempotência: mesma chave + mesmo corpo devolve o mesmo pedido ------
    const existing = await this.db.platform
      .select()
      .from(s.idempotencyKeys)
      .where(eq(s.idempotencyKeys.key, meta.idempotencyKey))
      .limit(1);

    if (existing[0]) {
      const stored = existing[0];
      if (!Buffer.from(stored.requestHash).equals(requestHash)) {
        throw unprocessable(
          'CHAVE_IDEMPOTENCIA_REUTILIZADA',
          'Idempotency-Key já usada com outro conteúdo',
        );
      }
      if (!stored.completedAt) {
        throw conflict('EM_PROCESSAMENTO', 'Requisição idêntica em processamento');
      }
      return { orderId: stored.resourceId!, replayed: true };
    }

    const orderId = uuidv7();

    await this.db.platform.insert(s.idempotencyKeys).values({
      key: meta.idempotencyKey,
      userId: principal.userId,
      endpoint: 'POST /v1/orders',
      requestHash,
      resourceId: orderId,
      expiresAt: new Date(Date.now() + 86_400_000),
    } as never);

    try {
      const context = await this.storefrontContext(principal, input.branchId);
      await this.db.withTenant(context, async (tx) => {
        await this.buildOrder(tx, principal, input, orderId, meta);
      });
    } catch (error) {
      // Falhou: libera a chave para o cliente poder tentar de novo.
      await this.db.platform
        .delete(s.idempotencyKeys)
        .where(eq(s.idempotencyKeys.key, meta.idempotencyKey));
      throw error;
    }

    await this.db.platform
      .update(s.idempotencyKeys)
      .set({ completedAt: new Date(), responseStatus: 201 })
      .where(eq(s.idempotencyKeys.key, meta.idempotencyKey));

    return { orderId, replayed: false };
  }

  /**
   * Contexto de tenant do checkout.
   *
   * O cliente é GLOBAL à plataforma (ADR-0012): a conta dele não pertence a
   * nenhuma organização. Mas o checkout opera sobre dados de UMA loja —
   * cardápio, estoque, zonas de entrega, chave Pix. Então, ao comprar, o
   * cliente entra no tenant daquela loja, com escopo restrito à unidade.
   *
   * Isso NÃO afrouxa o isolamento:
   *  - a política `orders_customer_isolation` continua exigindo
   *    `customer_id = current_user`, então ele só enxerga os próprios pedidos;
   *  - `users_customers_of_org` exige STAFF, então ele não lista outros clientes;
   *  - o que ele passa a enxergar (produtos, preços, unidade) é exatamente a
   *    vitrine pública daquela loja.
   *
   * A organização vem do BANCO a partir do branchId — nunca de um header
   * enviado pelo cliente.
   */
  private async storefrontContext(principal: Principal, branchId: string) {
    if (principal.userType === 'STAFF') return toTenantContext(principal);

    const rows = await this.db.platform
      .select({ organizationId: s.branches.organizationId })
      .from(s.branches)
      .where(and(eq(s.branches.id, branchId), isNull(s.branches.deletedAt)))
      .limit(1);

    const branch = rows[0];
    if (!branch) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada');

    return {
      userId: principal.userId,
      userType: 'CUSTOMER' as const,
      organizationId: branch.organizationId,
      branchScope: [branchId],
      isPlatformAdmin: false,
    };
  }

  private async buildOrder(
    tx: Db,
    principal: Principal,
    input: CreateOrderInput,
    orderId: string,
    meta: { ip?: string; requestId?: string },
  ): Promise<void> {
    if (input.items.length === 0) throw unprocessable('CARRINHO_VAZIO', 'Carrinho vazio');
    if (input.items.length > 100) throw unprocessable('CARRINHO_GRANDE', 'Carrinho muito grande');

    // --- unidade e configurações -------------------------------------------
    const branchRows = await tx
      .select({ branch: s.branches, settings: s.storeSettings })
      .from(s.branches)
      .innerJoin(s.storeSettings, eq(s.storeSettings.branchId, s.branches.id))
      .where(and(eq(s.branches.id, input.branchId), isNull(s.branches.deletedAt)))
      .limit(1);

    const found = branchRows[0];
    if (!found) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada');
    const { branch, settings } = found;

    if (branch.status !== 'ACTIVE') {
      throw conflict('LOJA_FECHADA', 'A unidade não está aceitando pedidos no momento');
    }

    // Horário de funcionamento. O cardápio já avisa que está fechado, mas quem
    // RECUSA é aqui: o cliente pode ter deixado a página aberta desde antes de
    // fechar, ou chamar a API direto. Sem horário cadastrado, a loja é
    // considerada aberta (ver `openState`).
    const hours = await tx
      .select({
        weekday: s.businessHours.weekday,
        opensAt: s.businessHours.opensAt,
        closesAt: s.businessHours.closesAt,
      })
      .from(s.businessHours)
      .where(eq(s.businessHours.branchId, branch.id));

    const open = openState(
      hours.map((h) => ({
        weekday: h.weekday as BusinessHour['weekday'],
        opensAt: h.opensAt.slice(0, 5),
        closesAt: h.closesAt.slice(0, 5),
      })),
    );
    if (!open.isOpen) {
      throw conflict('LOJA_FECHADA', describeOpenState(open));
    }
    if (input.fulfillment === 'DELIVERY' && !branch.acceptsDelivery) {
      throw unprocessable('ENTREGA_INDISPONIVEL', 'Esta unidade não faz entrega');
    }
    if (input.fulfillment === 'PICKUP' && !branch.acceptsPickup) {
      throw unprocessable('RETIRADA_INDISPONIVEL', 'Esta unidade não faz retirada');
    }
    if (!settings.enabledPaymentMethods.includes(input.paymentMethod)) {
      throw unprocessable('METODO_INDISPONIVEL', 'Método de pagamento não habilitado nesta unidade');
    }

    // --- produtos: PREÇO SEMPRE DO BANCO ------------------------------------
    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const productRows = await tx
      .select()
      .from(s.products)
      .where(
        and(
          inArray(s.products.id, productIds),
          eq(s.products.branchId, input.branchId), // produto de OUTRA unidade não entra
          eq(s.products.isActive, true),
          isNull(s.products.deletedAt),
        ),
      );

    const productsById = new Map(productRows.map((p) => [p.id, p]));
    for (const item of input.items) {
      if (!productsById.has(item.productId)) {
        throw conflict('PRODUTO_INVALIDO', 'Produto indisponível ou de outra unidade', {
          productId: item.productId,
        });
      }
    }

    // --- adicionais: preço e vínculo validados no servidor -------------------
    const optionIds = [...new Set(input.items.flatMap((i) => i.optionIds ?? []))];
    const optionRows =
      optionIds.length > 0
        ? await tx
            .select({
              option: s.modifierOptions,
              groupId: s.modifierGroups.id,
              groupName: s.modifierGroups.name,
            })
            .from(s.modifierOptions)
            .innerJoin(
              s.modifierGroups,
              eq(s.modifierGroups.id, s.modifierOptions.modifierGroupId),
            )
            .where(
              and(
                inArray(s.modifierOptions.id, optionIds),
                eq(s.modifierOptions.branchId, input.branchId),
                eq(s.modifierOptions.isAvailable, true),
                isNull(s.modifierOptions.deletedAt),
              ),
            )
        : [];

    const optionsById = new Map(optionRows.map((r) => [r.option.id, r]));

    // O adicional precisa pertencer a um grupo vinculado ÀQUELE produto.
    const links =
      optionIds.length > 0
        ? await tx
            .select()
            .from(s.productModifierGroups)
            .where(inArray(s.productModifierGroups.productId, productIds))
        : [];
    const groupsByProduct = new Map<string, Set<string>>();
    for (const l of links) {
      if (!groupsByProduct.has(l.productId)) groupsByProduct.set(l.productId, new Set());
      groupsByProduct.get(l.productId)!.add(l.modifierGroupId);
    }

    for (const item of input.items) {
      for (const optionId of item.optionIds ?? []) {
        const opt = optionsById.get(optionId);
        if (!opt) {
          throw conflict('OPCAO_INVALIDA', 'Adicional indisponível', { optionId });
        }
        if (!groupsByProduct.get(item.productId)?.has(opt.groupId)) {
          throw conflict('OPCAO_INVALIDA', 'Adicional não pertence a este produto', {
            optionId,
            productId: item.productId,
          });
        }
      }
    }

    /*
     * REGRA DO GRUPO — obrigatório, mínimo e máximo.
     *
     * O laço acima confere cada adicional ENVIADO; esta parte confere o que
     * NÃO foi enviado. Sem ela, um pedido que simplesmente omite o grupo
     * obrigatório passava: a tela impedia, mas uma chamada direta à API não.
     *
     * A regra é a mesma função que a tela usa (`validateModifierSelection`),
     * para que a explicação ao cliente e a recusa do servidor não divirjam.
     */
    const ruleRows = await tx
      .select({
        productId: s.productModifierGroups.productId,
        groupId: s.modifierGroups.id,
        groupName: s.modifierGroups.name,
        minSelect: s.modifierGroups.minSelect,
        maxSelect: s.modifierGroups.maxSelect,
        isRequired: s.modifierGroups.isRequired,
        optionId: s.modifierOptions.id,
      })
      .from(s.productModifierGroups)
      .innerJoin(
        s.modifierGroups,
        eq(s.modifierGroups.id, s.productModifierGroups.modifierGroupId),
      )
      .leftJoin(
        s.modifierOptions,
        and(
          eq(s.modifierOptions.modifierGroupId, s.modifierGroups.id),
          eq(s.modifierOptions.isAvailable, true),
          isNull(s.modifierOptions.deletedAt),
        ),
      )
      .where(
        and(
          inArray(s.productModifierGroups.productId, productIds),
          isNull(s.modifierGroups.deletedAt),
        ),
      );

    const rulesByProduct = new Map<string, Map<string, ModifierRule>>();
    for (const row of ruleRows) {
      if (!rulesByProduct.has(row.productId)) rulesByProduct.set(row.productId, new Map());
      const groups = rulesByProduct.get(row.productId)!;
      const existing = groups.get(row.groupId);
      if (existing) {
        if (row.optionId) (existing.optionIds as string[]).push(row.optionId);
      } else {
        groups.set(row.groupId, {
          id: row.groupId,
          name: row.groupName,
          minSelect: row.minSelect,
          maxSelect: row.maxSelect,
          isRequired: row.isRequired,
          optionIds: row.optionId ? [row.optionId] : [],
        });
      }
    }

    for (const item of input.items) {
      const groups = rulesByProduct.get(item.productId);
      if (!groups || groups.size === 0) continue;
      const check = validateModifierSelection([...groups.values()], item.optionIds ?? []);
      if (!check.ok) {
        throw unprocessable('ESCOLHA_INVALIDA', check.message, { productId: item.productId });
      }
    }

    // --- taxa de entrega: resolvida no servidor -----------------------------
    let deliveryFeeCents = 0;
    let deliveryZoneId: string | null = null;
    let addressSnapshot: Record<string, unknown> | null = null;

    if (input.fulfillment === 'DELIVERY') {
      if (!input.deliveryAddressId) {
        throw unprocessable('ENDERECO_OBRIGATORIO', 'Entrega exige endereço');
      }
      const addressRows = await tx
        .select()
        .from(s.deliveryAddresses)
        .where(
          and(
            eq(s.deliveryAddresses.id, input.deliveryAddressId),
            eq(s.deliveryAddresses.customerId, principal.userId), // posse
            isNull(s.deliveryAddresses.deletedAt),
          ),
        )
        .limit(1);

      const address = addressRows[0];
      // Endereço de outro cliente: 404, nunca 403 — não confirmamos existência.
      if (!address) throw notFound('ENDERECO_NAO_ENCONTRADO', 'Endereço não encontrado');

      const zone = await this.resolveDeliveryZone(tx, input.branchId, address);
      if (!zone) throw unprocessable('FORA_DA_AREA', 'Endereço fora da área de entrega');

      deliveryFeeCents = zone.feeCents;
      deliveryZoneId = zone.id;
      addressSnapshot = {
        postalCode: address.postalCode,
        street: address.street,
        streetNumber: address.streetNumber,
        complement: address.complement,
        district: address.district,
        city: address.city,
        stateCode: address.stateCode,
        reference: address.reference,
      };
    }

    // --- cálculo (pacote domain, com dados do banco) ------------------------
    const priced = priceOrder({
      items: input.items.map((item) => ({
        unitPriceCents: productsById.get(item.productId)!.priceCents,
        quantity: item.quantity,
        options: (item.optionIds ?? []).map((id) => ({
          priceDeltaCents: optionsById.get(id)!.option.priceDeltaCents,
          quantity: 1,
        })),
      })),
      deliveryFeeCents,
      discountCents: 0,
    });

    if (priced.subtotalCents < settings.minOrderCents) {
      throw unprocessable('PEDIDO_MINIMO', 'Pedido abaixo do valor mínimo da unidade', {
        minOrderCents: settings.minOrderCents,
        subtotalCents: priced.subtotalCents,
      });
    }

    // O total informado pelo app NÃO cobra nada — serve só para detectar que o
    // preço mudou entre montar o carrinho e finalizar, e avisar o cliente.
    if (
      input.expectedTotalCents !== undefined &&
      input.expectedTotalCents !== priced.totalCents
    ) {
      throw conflict('PRECO_ALTERADO', 'Os valores mudaram; confirme o novo total', {
        expectedTotalCents: input.expectedTotalCents,
        actualTotalCents: priced.totalCents,
        subtotalCents: priced.subtotalCents,
        deliveryFeeCents: priced.deliveryFeeCents,
      });
    }

    // --- número amigável (atômico por unidade) ------------------------------
    const holdMinutes = settings.paymentHoldMinutes;
    const reservationExpiresAt = new Date(Date.now() + holdMinutes * 60_000);
    // UMA data calculada aqui, usada tanto no contador quanto no pedido: são o
    // mesmo "dia de operação", e um contador nunca pode achar um dia diferente
    // do que o pedido efetivamente grava (ver migração 0005).
    const businessDate = businessDateFor(new Date(), branch.timezone);
    const orderNumber = await this.nextOrderNumber(tx, input.branchId, businessDate);

    // --- persistência do pedido ---------------------------------------------
    // O pedido é inserido ANTES da reserva porque inventory_reservations tem FK
    // para orders. Tudo roda na mesma transação: se a reserva falhar por falta
    // de estoque, o ROLLBACK desfaz o pedido e nada sobra.
    await tx.insert(s.orders).values({
      id: orderId,
      organizationId: branch.organizationId,
      branchId: input.branchId,
      customerId: principal.userId,
      orderNumber,
      businessDate,
      status: 'PENDING',
      fulfillment: input.fulfillment,
      paymentMethod: input.paymentMethod,
      subtotalCents: priced.subtotalCents,
      deliveryFeeCents: priced.deliveryFeeCents,
      discountCents: priced.discountCents,
      totalCents: priced.totalCents,
      deliveryAddressId: input.deliveryAddressId ?? null,
      deliveryAddressSnapshot: addressSnapshot,
      deliveryZoneId,
      customerNotes: input.customerNotes ?? null,
      changeForCents: input.changeForCents ?? null,
      reservationExpiresAt: input.paymentMethod === 'PIX' ? reservationExpiresAt : null,
      estimatedReadyAt: new Date(Date.now() + settings.preparationTimeMinutes * 60_000),
      clientIp: meta.ip ?? null,
    } as never);

    // --- reserva de estoque (atômica, itens ordenados por product_id) -------
    const aggregated = new Map<string, number>();
    for (const item of input.items) {
      aggregated.set(item.productId, (aggregated.get(item.productId) ?? 0) + item.quantity);
    }

    await this.inventory.reserveForOrder(tx, {
      orderId,
      organizationId: branch.organizationId,
      branchId: input.branchId,
      items: [...aggregated].map(([productId, quantity]) => ({ productId, quantity })),
      expiresAt: reservationExpiresAt,
      actorUserId: principal.userId,
    });

    for (const [index, item] of input.items.entries()) {
      const product = productsById.get(item.productId)!;
      const line = priced.lines[index]!;
      const itemId = uuidv7();

      await tx.insert(s.orderItems).values({
        id: itemId,
        orderId,
        productId: item.productId,
        // SNAPSHOT: o pedido de ontem não muda quando o preço muda hoje.
        productNameSnapshot: product.name,
        productSkuSnapshot: product.sku,
        unitPriceCentsSnapshot: line.unitPriceCents,
        quantity: line.quantity,
        optionsTotalCents: line.optionsTotalCents,
        lineTotalCents: line.lineTotalCents,
        notes: item.notes ?? null,
      } as never);

      for (const optionId of item.optionIds ?? []) {
        const opt = optionsById.get(optionId)!;
        await tx.insert(s.orderItemOptions).values({
          id: uuidv7(),
          orderItemId: itemId,
          modifierOptionId: optionId,
          optionNameSnapshot: opt.option.name,
          groupNameSnapshot: opt.groupName,
          priceDeltaCentsSnapshot: opt.option.priceDeltaCents,
          quantity: 1,
        } as never);
      }
    }

    await tx.insert(s.orderStatusHistory).values({
      id: uuidv7(),
      orderId,
      organizationId: branch.organizationId,
      branchId: input.branchId,
      fromStatus: null,
      toStatus: 'PENDING',
      actorUserId: principal.userId,
      actorType: 'CUSTOMER',
      ipAddress: meta.ip ?? null,
    } as never);

    // --- pagamento (máquina de estados SEPARADA) ----------------------------
    await this.payments.createForOrder(tx, {
      orderId,
      organizationId: branch.organizationId,
      branchId: input.branchId,
      method: input.paymentMethod,
      amountCents: priced.totalCents,
      orderNumber,
    });

    // --- vínculo cliente-franquia (LGPD: escopo de visibilidade) ------------
    await tx.execute(sql`
      INSERT INTO customer_organization_links
        (id, customer_id, organization_id, first_order_at, last_order_at, orders_count)
      VALUES (${uuidv7()}, ${principal.userId}, ${branch.organizationId}, now(), now(), 1)
      ON CONFLICT (customer_id, organization_id)
      DO UPDATE SET last_order_at = now(), orders_count = customer_organization_links.orders_count + 1
    `);

    await this.audit.record(tx, {
      principal,
      organizationId: branch.organizationId,
      branchId: input.branchId,
      action: 'order.created',
      resourceType: 'order',
      resourceId: orderId,
      ip: meta.ip,
      requestId: meta.requestId,
      metadata: {
        orderNumber,
        totalCents: priced.totalCents,
        paymentMethod: input.paymentMethod,
        fulfillment: input.fulfillment,
      },
    });

    await this.outbox.publish(tx, {
      organizationId: branch.organizationId,
      branchId: input.branchId,
      aggregateType: 'order',
      aggregateId: orderId,
      eventType: 'order.created',
      payload: { orderId, orderNumber, branchId: input.branchId, status: 'PENDING' },
    });
  }

  /**
   * Numeração amigável atômica por unidade.
   * INSERT ... ON CONFLICT DO UPDATE ... RETURNING é uma única operação: 50
   * pedidos simultâneos produzem 50 números distintos, sem lacuna nem colisão.
   */
  private async nextOrderNumber(tx: Db, branchId: string, businessDate: string): Promise<string> {
    const result = await tx.execute(sql`
      INSERT INTO order_number_counters (branch_id, business_date, last_number)
      VALUES (${branchId}, ${businessDate}, 1)
      ON CONFLICT (branch_id, business_date)
      DO UPDATE SET last_number = order_number_counters.last_number + 1
      RETURNING last_number
    `);
    return formatOrderNumber((result.rows[0] as { last_number: number }).last_number);
  }

  private async resolveDeliveryZone(
    tx: Db,
    branchId: string,
    address: { postalCode: string; latitude: number | null; longitude: number | null },
  ): Promise<{ id: string; feeCents: number } | null> {
    const zones = await tx
      .select()
      .from(s.deliveryZones)
      .where(
        and(
          eq(s.deliveryZones.branchId, branchId),
          eq(s.deliveryZones.isActive, true),
          isNull(s.deliveryZones.deletedAt),
        ),
      );

    const branchRows = await tx
      .select({ latitude: s.branches.latitude, longitude: s.branches.longitude })
      .from(s.branches)
      .where(eq(s.branches.id, branchId))
      .limit(1);
    const origin = branchRows[0];

    const normalizedCep = address.postalCode.replace(/\D/g, '');
    const matches: Array<{ id: string; feeCents: number }> = [];

    for (const zone of zones) {
      if (zone.type === 'POSTAL_RANGE') {
        const from = (zone.postalCodeFrom ?? '').replace(/\D/g, '');
        const to = (zone.postalCodeTo ?? '').replace(/\D/g, '');
        if (normalizedCep >= from && normalizedCep <= to) {
          matches.push({ id: zone.id, feeCents: zone.feeCents });
        }
      } else if (
        zone.type === 'RADIUS' &&
        zone.radiusMeters &&
        origin?.latitude != null &&
        origin.longitude != null &&
        address.latitude != null &&
        address.longitude != null
      ) {
        const meters = haversineMeters(
          origin.latitude,
          origin.longitude,
          address.latitude,
          address.longitude,
        );
        if (meters <= zone.radiusMeters) {
          matches.push({ id: zone.id, feeCents: zone.feeCents });
        }
      }
    }

    if (matches.length === 0) return null;
    // Zonas podem se sobrepor: escolhemos deterministicamente a de MENOR taxa,
    // para que a cobrança não dependa da ordem de inserção.
    matches.sort((a, b) => a.feeCents - b.feeCents);
    return matches[0]!;
  }

  // ===========================================================================
  // TRANSIÇÕES DE STATUS
  // ===========================================================================

  async transition(
    principal: Principal,
    branchId: string,
    orderId: string,
    to: OrderStatus,
    options: { reason?: string; ip?: string } = {},
  ): Promise<{ status: OrderStatus }> {
    // Escopo de unidade só se aplica a STAFF. A autoridade do CLIENTE é a POSSE
    // do pedido, garantida pela política `orders_customer_isolation` — ele não
    // pertence a organização nenhuma (ADR-0012).
    if (principal.userType === 'STAFF') {
      await this.branchAccess.assertAccess(principal, branchId);
    }
    const context = await this.storefrontContext(principal, branchId);

    return this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select()
        .from(s.orders)
        .where(and(eq(s.orders.id, orderId), eq(s.orders.branchId, branchId)))
        .limit(1);

      const order = rows[0];
      // RLS + escopo já filtraram. Ausência = não existe para este ator.
      if (!order) throw notFound();

      const paymentRows = await tx
        .select()
        .from(s.payments)
        .where(eq(s.payments.orderId, orderId))
        .orderBy(desc(s.payments.createdAt))
        .limit(1);
      const payment = paymentRows[0];

      const actorType: ActorType = principal.userType === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF';

      const check = canTransition({
        from: order.status,
        to,
        fulfillment: order.fulfillment,
        actorType,
        paymentMethod: order.paymentMethod,
        paymentConfirmed: payment?.status === 'CONFIRMED',
        reason: options.reason,
      });

      if (!check.allowed) {
        throw conflict(check.code, check.message, { from: order.status, to });
      }

      // A permissão declarada na regra é conferida aqui — a máquina de estados
      // e o RBAC continuam sendo verificações independentes.
      if (check.rule.permission && !principal.permissions.has(check.rule.permission)) {
        throw conflict('PERMISSAO_NEGADA', `Permissão necessária: ${check.rule.permission}`);
      }

      const now = new Date();
      const patch: Record<string, unknown> = { status: to };
      if (to === 'CONFIRMED') patch.confirmedAt = now;
      if (to === 'READY') patch.readyAt = now;
      if (to === 'DELIVERED' || to === 'PICKED_UP') patch.completedAt = now;
      if (to === 'CANCELLED' || to === 'REJECTED' || to === 'EXPIRED') {
        patch.cancelledAt = now;
        patch.cancellationReason = options.reason ?? null;
      }

      await tx.update(s.orders).set(patch).where(eq(s.orders.id, orderId));

      await tx.insert(s.orderStatusHistory).values({
        id: uuidv7(),
        orderId,
        organizationId: order.organizationId,
        branchId,
        fromStatus: order.status,
        toStatus: to,
        actorUserId: principal.userId,
        actorType,
        reason: options.reason ?? null,
        ipAddress: options.ip ?? null,
      } as never);

      // Estoque: confirmar consome; cancelar devolve.
      if (to === 'CONFIRMED') {
        await this.inventory.commitReservations(tx, orderId, principal.userId);
      }
      if (to === 'CANCELLED' || to === 'REJECTED' || to === 'EXPIRED') {
        await this.inventory.releaseReservations(tx, orderId, 'RELEASE', principal.userId);
      }

      await this.audit.record(tx, {
        principal,
        organizationId: order.organizationId,
        branchId,
        action: 'order.status_changed',
        resourceType: 'order',
        resourceId: orderId,
        ip: options.ip,
        metadata: { from: order.status, to, reason: options.reason ?? null },
      });

      await this.outbox.publish(tx, {
        organizationId: order.organizationId,
        branchId,
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.status_changed',
        payload: {
          orderId,
          orderNumber: order.orderNumber,
          branchId,
          from: order.status,
          to,
          customerId: order.customerId,
        },
      });

      return { status: to };
    });
  }

  // ===========================================================================
  // Consultas
  // ===========================================================================

  async getOrderDetail(principal: Principal, orderId: string) {
    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx.select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1);
      const order = rows[0];
      if (!order) throw notFound();

      const items = await tx
        .select()
        .from(s.orderItems)
        .where(eq(s.orderItems.orderId, orderId));
      const itemIds = items.map((i) => i.id);
      const options =
        itemIds.length > 0
          ? await tx
              .select()
              .from(s.orderItemOptions)
              .where(inArray(s.orderItemOptions.orderItemId, itemIds))
          : [];
      const paymentRows = await tx
        .select()
        .from(s.payments)
        .where(eq(s.payments.orderId, orderId))
        .orderBy(desc(s.payments.createdAt))
        .limit(1);
      const history = await tx
        .select()
        .from(s.orderStatusHistory)
        .where(eq(s.orderStatusHistory.orderId, orderId))
        .orderBy(s.orderStatusHistory.createdAt);

      return { order, items, options, payment: paymentRows[0] ?? null, history };
    });
  }

  /** Fila do operador, agrupada por status (item 9 do Prompt 02). */
  async listBranchOrders(
    principal: Principal,
    branchId: string,
    filter: { statuses?: OrderStatus[]; limit?: number } = {},
  ) {
    await this.branchAccess.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const statuses = filter.statuses?.length
        ? filter.statuses
        : [...ACTIVE_ORDER_STATUSES];

      const orders = await tx
        .select()
        .from(s.orders)
        .where(and(eq(s.orders.branchId, branchId), inArray(s.orders.status, statuses)))
        .orderBy(desc(s.orders.placedAt))
        .limit(Math.min(filter.limit ?? 100, 200));

      if (orders.length === 0) return [];

      const orderIds = orders.map((o) => o.id);
      const items = await tx
        .select()
        .from(s.orderItems)
        .where(inArray(s.orderItems.orderId, orderIds));
      const paymentRows = await tx
        .select()
        .from(s.payments)
        .where(inArray(s.payments.orderId, orderIds));

      const itemsByOrder = new Map<string, typeof items>();
      for (const item of items) {
        const list = itemsByOrder.get(item.orderId) ?? [];
        list.push(item);
        itemsByOrder.set(item.orderId, list);
      }
      const paymentByOrder = new Map(paymentRows.map((p) => [p.orderId, p]));

      return orders.map((order) => ({
        order,
        items: itemsByOrder.get(order.id) ?? [],
        payment: paymentByOrder.get(order.id) ?? null,
      }));
    });
  }

  async listCustomerOrders(principal: Principal, limit = 30) {
    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const orders = await tx
        .select()
        .from(s.orders)
        .where(eq(s.orders.customerId, principal.userId))
        .orderBy(desc(s.orders.placedAt))
        .limit(Math.min(limit, 100));

      if (orders.length === 0) return [];
      const orderIds = orders.map((o) => o.id);
      const items = await tx
        .select()
        .from(s.orderItems)
        .where(inArray(s.orderItems.orderId, orderIds));
      const paymentRows = await tx
        .select()
        .from(s.payments)
        .where(inArray(s.payments.orderId, orderIds));

      const itemsByOrder = new Map<string, typeof items>();
      for (const item of items) {
        const list = itemsByOrder.get(item.orderId) ?? [];
        list.push(item);
        itemsByOrder.set(item.orderId, list);
      }
      const paymentByOrder = new Map(paymentRows.map((p) => [p.orderId, p]));

      return orders.map((order) => ({
        order,
        items: itemsByOrder.get(order.id) ?? [],
        payment: paymentByOrder.get(order.id) ?? null,
      }));
    });
  }

  /**
   * Expira pedidos Pix cuja janela de pagamento venceu e devolve o estoque.
   * Sem este job, um pedido abandonado trancaria o produto para sempre — é o
   * risco de maior probabilidade do sistema (docs/00 §9).
   */
  async expireStaleOrders(now = new Date()): Promise<number> {
    return this.db.withPlatform(async (tx) => {
      const stale = await tx.execute(sql`
        SELECT id, organization_id, branch_id, order_number, customer_id, status
          FROM orders
         WHERE status = 'PENDING'
           AND reservation_expires_at IS NOT NULL
           AND reservation_expires_at < ${now}
         ORDER BY reservation_expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT 100
      `);

      for (const row of stale.rows as Array<Record<string, string>>) {
        await tx
          .update(s.orders)
          .set({ status: 'EXPIRED', cancelledAt: now, cancellationReason: 'Pagamento não confirmado' })
          .where(eq(s.orders.id, row.id!));

        await tx.insert(s.orderStatusHistory).values({
          id: uuidv7(),
          orderId: row.id,
          organizationId: row.organization_id,
          branchId: row.branch_id,
          fromStatus: 'PENDING',
          toStatus: 'EXPIRED',
          actorUserId: null,
          actorType: 'SYSTEM',
          reason: 'Janela de pagamento expirada',
        } as never);

        await this.inventory.releaseReservations(tx, row.id!, 'EXPIRE_RELEASE', null);

        await tx
          .update(s.payments)
          .set({ status: 'CANCELLED' })
          .where(
            and(
              eq(s.payments.orderId, row.id!),
              inArray(s.payments.status, ['PENDING', 'AWAITING_CONFIRMATION']),
            ),
          );

        await this.outbox.publish(tx, {
          organizationId: row.organization_id!,
          branchId: row.branch_id!,
          aggregateType: 'order',
          aggregateId: row.id!,
          eventType: 'order.status_changed',
          payload: {
            orderId: row.id,
            orderNumber: row.order_number,
            branchId: row.branch_id,
            from: 'PENDING',
            to: 'EXPIRED',
            customerId: row.customer_id,
          },
        });
      }

      return stale.rows.length;
    });
  }
}

/** Distância entre dois pontos na superfície da Terra, em metros. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
