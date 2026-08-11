import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { resolveAvailability } from '@plataforma/domain';
import { Database, type Db } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { conflict, notFound } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../notifications/outbox.service.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

export interface UpsertProductInput {
  name: string;
  description?: string | null;
  categoryId?: string | null;
  priceCents: number;
  sku?: string | null;
  position?: number;
  isActive?: boolean;
  isFeatured?: boolean;
  notes?: string | null;
  allowsCustomerNotes?: boolean;
  preparationTimeMinutes?: number | null;
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(BranchAccessService) private readonly branchAccess: BranchAccessService,
  ) {}

  // ===========================================================================
  // Vitrine pública (cliente)
  // ===========================================================================

  /**
   * Cardápio da unidade, agrupado por categoria.
   *
   * O cardápio é cacheável (nomes, preços, fotos); a DISPONIBILIDADE não é —
   * ela é resolvida agora, a cada leitura. Cachear estoque produziria
   * overselling visível: o cliente montaria o carrinho com dado velho e levaria
   * 409 no checkout (docs/05 §8).
   */
  async getPublicMenu(branchSlug: string, organizationSlug: string) {
    const branchRows = await this.db.platform
      .select({ branch: s.branches, branding: s.brandingSettings, settings: s.storeSettings })
      .from(s.branches)
      .innerJoin(s.organizations, eq(s.organizations.id, s.branches.organizationId))
      .leftJoin(s.brandingSettings, eq(s.brandingSettings.branchId, s.branches.id))
      .leftJoin(s.storeSettings, eq(s.storeSettings.branchId, s.branches.id))
      .where(
        and(
          eq(s.organizations.slug, organizationSlug),
          eq(s.branches.slug, branchSlug),
          isNull(s.branches.deletedAt),
        ),
      )
      .limit(1);

    const found = branchRows[0];
    if (!found) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Estabelecimento não encontrado');
    const { branch, branding, settings } = found;

    const categories = await this.db.platform
      .select()
      .from(s.categories)
      .where(
        and(
          eq(s.categories.branchId, branch.id),
          eq(s.categories.isActive, true),
          isNull(s.categories.deletedAt),
        ),
      )
      .orderBy(asc(s.categories.position), asc(s.categories.name));

    const products = await this.db.platform
      .select({ product: s.products, inventory: s.virtualInventory })
      .from(s.products)
      .leftJoin(s.virtualInventory, eq(s.virtualInventory.productId, s.products.id))
      .where(
        and(
          eq(s.products.branchId, branch.id),
          eq(s.products.isActive, true),
          isNull(s.products.deletedAt),
        ),
      )
      .orderBy(asc(s.products.position), asc(s.products.name));

    const productIds = products.map((p) => p.product.id);
    const images =
      productIds.length > 0
        ? await this.db.platform
            .select()
            .from(s.productImages)
            .where(
              and(inArray(s.productImages.productId, productIds), isNull(s.productImages.deletedAt)),
            )
            .orderBy(asc(s.productImages.position))
        : [];

    const imagesByProduct = new Map<string, typeof images>();
    for (const img of images) {
      const list = imagesByProduct.get(img.productId) ?? [];
      list.push(img);
      imagesByProduct.set(img.productId, list);
    }

    const decorated = products.map(({ product, inventory }) => {
      const availability = inventory
        ? resolveAvailability({
            mode: inventory.mode,
            onHandQty: inventory.onHandQty,
            reservedQty: inventory.reservedQty,
            isManuallySoldOut: inventory.isManuallySoldOut,
          })
        : { status: 'AVAILABLE' as const, isPurchasable: true, availableQuantity: null };

      const productImageList = imagesByProduct.get(product.id) ?? [];
      const primary = productImageList.find((i) => i.isPrimary) ?? productImageList[0] ?? null;

      return {
        id: product.id,
        name: product.name,
        description: product.description,
        priceCents: product.priceCents,
        categoryId: product.categoryId,
        isFeatured: product.isFeatured,
        allowsCustomerNotes: product.allowsCustomerNotes,
        preparationTimeMinutes: product.preparationTimeMinutes,
        imageUrl: primary ? `/v1/media/${primary.storageKey}` : null,
        thumbUrl: primary?.thumbStorageKey ? `/v1/media/${primary.thumbStorageKey}` : null,
        blurhash: primary?.blurhash ?? null,
        availability,
      };
    });

    return {
      branch: {
        id: branch.id,
        name: branch.name,
        slug: branch.slug,
        status: branch.status,
        acceptsPickup: branch.acceptsPickup,
        acceptsDelivery: branch.acceptsDelivery,
        city: branch.city,
        district: branch.district,
      },
      branding: branding
        ? {
            displayName: branding.displayName ?? branch.name,
            tagline: branding.tagline,
            primaryColor: branding.primaryColor,
            secondaryColor: branding.secondaryColor,
            logoUrl: branding.logoStorageKey ? `/v1/media/${branding.logoStorageKey}` : null,
          }
        : null,
      settings: settings
        ? {
            minOrderCents: settings.minOrderCents,
            preparationTimeMinutes: settings.preparationTimeMinutes,
            enabledPaymentMethods: settings.enabledPaymentMethods,
          }
        : null,
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        products: decorated.filter((p) => p.categoryId === c.id),
      })),
      featured: decorated.filter((p) => p.isFeatured),
      uncategorized: decorated.filter((p) => p.categoryId === null),
    };
  }

  /** Página do produto: foto, nome, descrição, preço, adicionais. */
  async getProductDetail(productId: string) {
    const rows = await this.db.platform
      .select({ product: s.products, inventory: s.virtualInventory })
      .from(s.products)
      .leftJoin(s.virtualInventory, eq(s.virtualInventory.productId, s.products.id))
      .where(
        and(
          eq(s.products.id, productId),
          eq(s.products.isActive, true),
          isNull(s.products.deletedAt),
        ),
      )
      .limit(1);

    const found = rows[0];
    if (!found) throw notFound('PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado');

    const images = await this.db.platform
      .select()
      .from(s.productImages)
      .where(and(eq(s.productImages.productId, productId), isNull(s.productImages.deletedAt)))
      .orderBy(asc(s.productImages.position));

    const groups = await this.db.platform
      .select({ group: s.modifierGroups })
      .from(s.productModifierGroups)
      .innerJoin(s.modifierGroups, eq(s.modifierGroups.id, s.productModifierGroups.modifierGroupId))
      .where(
        and(
          eq(s.productModifierGroups.productId, productId),
          isNull(s.modifierGroups.deletedAt),
        ),
      )
      .orderBy(asc(s.productModifierGroups.position));

    const groupIds = groups.map((g) => g.group.id);
    const options =
      groupIds.length > 0
        ? await this.db.platform
            .select()
            .from(s.modifierOptions)
            .where(
              and(
                inArray(s.modifierOptions.modifierGroupId, groupIds),
                isNull(s.modifierOptions.deletedAt),
              ),
            )
            .orderBy(asc(s.modifierOptions.position))
        : [];

    const availability = found.inventory
      ? resolveAvailability({
          mode: found.inventory.mode,
          onHandQty: found.inventory.onHandQty,
          reservedQty: found.inventory.reservedQty,
          isManuallySoldOut: found.inventory.isManuallySoldOut,
        })
      : { status: 'AVAILABLE' as const, isPurchasable: true, availableQuantity: null };

    return {
      id: found.product.id,
      name: found.product.name,
      description: found.product.description,
      priceCents: found.product.priceCents,
      isFeatured: found.product.isFeatured,
      allowsCustomerNotes: found.product.allowsCustomerNotes,
      images: images.map((i) => ({
        url: `/v1/media/${i.storageKey}`,
        thumbUrl: i.thumbStorageKey ? `/v1/media/${i.thumbStorageKey}` : null,
        blurhash: i.blurhash,
        altText: i.altText,
      })),
      availability,
      modifierGroups: groups.map(({ group }) => ({
        id: group.id,
        name: group.name,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
        isRequired: group.isRequired,
        options: options
          .filter((o) => o.modifierGroupId === group.id && o.isAvailable)
          .map((o) => ({ id: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents })),
      })),
    };
  }

  // ===========================================================================
  // Gestão (operador/gerente)
  // ===========================================================================

  async listCategories(principal: Principal, branchId: string) {
    await this.branchAccess.assertAccess(principal, branchId);
    return this.db.withTenant(toTenantContext(principal), (tx) =>
      tx
        .select()
        .from(s.categories)
        .where(and(eq(s.categories.branchId, branchId), isNull(s.categories.deletedAt)))
        .orderBy(asc(s.categories.position)),
    );
  }

  async createCategory(
    principal: Principal,
    branchId: string,
    input: { name: string; description?: string; position?: number },
  ) {
    await this.branchAccess.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const branch = await this.loadBranch(tx, branchId);
      const inserted = await tx
        .insert(s.categories)
        .values({
          id: uuidv7(),
          organizationId: branch.organizationId,
          branchId,
          name: input.name,
          description: input.description ?? null,
          position: input.position ?? 0,
        } as never)
        .returning();

      await this.audit.record(tx, {
        principal,
        organizationId: branch.organizationId,
        branchId,
        action: 'category.created',
        resourceType: 'category',
        resourceId: inserted[0]!.id,
        metadata: { name: input.name },
      });
      return inserted[0]!;
    });
  }

  async listProducts(principal: Principal, branchId: string) {
    await this.branchAccess.assertAccess(principal, branchId);
    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select({ product: s.products, inventory: s.virtualInventory })
        .from(s.products)
        .leftJoin(s.virtualInventory, eq(s.virtualInventory.productId, s.products.id))
        .where(and(eq(s.products.branchId, branchId), isNull(s.products.deletedAt)))
        .orderBy(asc(s.products.position), asc(s.products.name));

      return rows.map(({ product, inventory }) => ({
        ...product,
        availability: inventory
          ? resolveAvailability({
              mode: inventory.mode,
              onHandQty: inventory.onHandQty,
              reservedQty: inventory.reservedQty,
              isManuallySoldOut: inventory.isManuallySoldOut,
            })
          : null,
      }));
    });
  }

  async createProduct(principal: Principal, branchId: string, input: UpsertProductInput) {
    await this.branchAccess.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const branch = await this.loadBranch(tx, branchId);

      // A categoria precisa ser da MESMA unidade. A FK composta no banco também
      // garante isso — aqui devolvemos um erro legível em vez de violação de FK.
      if (input.categoryId) {
        const category = await tx
          .select({ id: s.categories.id })
          .from(s.categories)
          .where(
            and(
              eq(s.categories.id, input.categoryId),
              eq(s.categories.branchId, branchId),
              isNull(s.categories.deletedAt),
            ),
          )
          .limit(1);
        if (!category[0]) throw conflict('CATEGORIA_INVALIDA', 'Categoria não pertence à unidade');
      }

      const productId = uuidv7();
      const inserted = await tx
        .insert(s.products)
        .values({
          id: productId,
          organizationId: branch.organizationId,
          branchId,
          categoryId: input.categoryId ?? null,
          name: input.name,
          description: input.description ?? null,
          sku: input.sku ?? null,
          priceCents: input.priceCents,
          isActive: input.isActive ?? true,
          isFeatured: input.isFeatured ?? false,
          notes: input.notes ?? null,
          allowsCustomerNotes: input.allowsCustomerNotes ?? true,
          preparationTimeMinutes: input.preparationTimeMinutes ?? null,
          position: input.position ?? 0,
        } as never)
        .returning();

      // Todo produto nasce com registro de disponibilidade em modo ILIMITADO:
      // exigir cadastro de quantidade para 800 SKUs mataria a adoção.
      await tx.insert(s.virtualInventory).values({
        id: uuidv7(),
        organizationId: branch.organizationId,
        branchId,
        productId,
        mode: 'INFINITE',
        onHandQty: 0,
        reservedQty: 0,
      } as never);

      await this.audit.record(tx, {
        principal,
        organizationId: branch.organizationId,
        branchId,
        action: 'product.created',
        resourceType: 'product',
        resourceId: productId,
        metadata: { name: input.name, priceCents: input.priceCents },
      });

      await this.outbox.publish(tx, {
        organizationId: branch.organizationId,
        branchId,
        aggregateType: 'inventory',
        aggregateId: productId,
        eventType: 'catalog.changed',
        payload: { branchId, productId },
      });

      return inserted[0]!;
    });
  }

  async updateProduct(
    principal: Principal,
    branchId: string,
    productId: string,
    input: Partial<UpsertProductInput>,
  ) {
    await this.branchAccess.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.products)
        .where(
          and(
            eq(s.products.id, productId),
            eq(s.products.branchId, branchId),
            isNull(s.products.deletedAt),
          ),
        )
        .limit(1);

      const product = rows[0];
      if (!product) throw notFound();

      // Alterar preço é permissão separada de alterar produto.
      const changingPrice =
        input.priceCents !== undefined && input.priceCents !== product.priceCents;
      if (changingPrice && !principal.permissions.has('price:update')) {
        throw conflict('PERMISSAO_NEGADA', 'Permissão necessária: price:update');
      }

      const patch: Record<string, unknown> = {};
      for (const key of [
        'name',
        'description',
        'categoryId',
        'priceCents',
        'sku',
        'position',
        'isActive',
        'isFeatured',
        'notes',
        'allowsCustomerNotes',
        'preparationTimeMinutes',
      ] as const) {
        if (input[key] !== undefined) patch[key] = input[key];
      }

      const updated = await tx
        .update(s.products)
        .set(patch)
        .where(eq(s.products.id, productId))
        .returning();

      await this.audit.record(tx, {
        principal,
        organizationId: product.organizationId,
        branchId,
        action: changingPrice ? 'product.price_updated' : 'product.updated',
        resourceType: 'product',
        resourceId: productId,
        metadata: changingPrice
          ? { from: product.priceCents, to: input.priceCents }
          : { fields: Object.keys(patch) },
      });

      await this.outbox.publish(tx, {
        organizationId: product.organizationId,
        branchId,
        aggregateType: 'inventory',
        aggregateId: productId,
        eventType: 'catalog.changed',
        payload: { branchId, productId },
      });

      return updated[0]!;
    });
  }

  async deleteProduct(principal: Principal, branchId: string, productId: string): Promise<void> {
    await this.branchAccess.assertAccess(principal, branchId);

    await this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.products)
        .where(and(eq(s.products.id, productId), eq(s.products.branchId, branchId)))
        .limit(1);
      const product = rows[0];
      if (!product) throw notFound();

      // Soft delete: pedidos históricos apontam para este produto.
      await tx
        .update(s.products)
        .set({ deletedAt: new Date(), isActive: false })
        .where(eq(s.products.id, productId));

      await this.audit.record(tx, {
        principal,
        organizationId: product.organizationId,
        branchId,
        action: 'product.deleted',
        resourceType: 'product',
        resourceId: productId,
        metadata: { name: product.name },
      });
    });
  }

  private async loadBranch(tx: Db, branchId: string) {
    const rows = await tx
      .select({ organizationId: s.branches.organizationId })
      .from(s.branches)
      .where(eq(s.branches.id, branchId))
      .limit(1);
    const branch = rows[0];
    if (!branch) throw notFound();
    return branch;
  }
}
