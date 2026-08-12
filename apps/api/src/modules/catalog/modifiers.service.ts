import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from '../../common/uuid.js';
import { Database, type Db } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { notFound, unprocessable } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

/**
 * OPÇÕES DO PRODUTO — o que o cliente escolhe ao pedir.
 *
 * Um GRUPO é a pergunta ("Tamanho", "Adicionais"); as OPÇÕES são as respostas
 * ("Médio", "Bacon +R$ 4,00"). O grupo carrega a regra de escolha — obrigatório
 * ou não, quantas no mínimo, quantas no máximo — e é essa regra que o checkout
 * aplica ao receber o pedido.
 *
 * Grupos pertencem à UNIDADE, não ao produto: "Adicionais" costuma valer para
 * vários lanches, e duplicá-lo por produto significaria editar em N lugares
 * quando o preço do bacon mudasse. O vínculo é uma tabela à parte.
 *
 * Remoção é lógica (`deleted_at`), nunca física: pedidos antigos apontam para a
 * opção escolhida, e apagá-la de verdade quebraria o histórico.
 */
export interface ModifierGroupInput {
  name: string;
  minSelect?: number;
  maxSelect?: number;
  isRequired?: boolean;
  position?: number;
}

export interface ModifierOptionInput {
  name: string;
  priceDeltaCents?: number;
  isAvailable?: boolean;
  position?: number;
}

@Injectable()
export class ModifiersService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BranchAccessService) private readonly access: BranchAccessService,
  ) {}

  /** Grupos da unidade, com as opções de cada um. */
  async list(principal: Principal, branchId: string) {
    await this.access.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const groups = await tx
        .select()
        .from(s.modifierGroups)
        .where(and(eq(s.modifierGroups.branchId, branchId), isNull(s.modifierGroups.deletedAt)))
        .orderBy(asc(s.modifierGroups.position), asc(s.modifierGroups.name));

      const options = await tx
        .select()
        .from(s.modifierOptions)
        .where(and(eq(s.modifierOptions.branchId, branchId), isNull(s.modifierOptions.deletedAt)))
        .orderBy(asc(s.modifierOptions.position), asc(s.modifierOptions.name));

      return groups.map((group) => ({
        id: group.id,
        name: group.name,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
        isRequired: group.isRequired,
        position: group.position,
        options: options
          .filter((option) => option.modifierGroupId === group.id)
          .map((option) => ({
            id: option.id,
            name: option.name,
            priceDeltaCents: Number(option.priceDeltaCents),
            isAvailable: option.isAvailable,
            position: option.position,
          })),
      }));
    });
  }

  async createGroup(principal: Principal, branchId: string, input: ModifierGroupInput) {
    const organizationId = await this.access.assertAccess(principal, branchId);
    assertSelectRange(input);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const inserted = await tx
        .insert(s.modifierGroups)
        .values({
          id: uuidv7(),
          organizationId,
          branchId,
          name: input.name,
          minSelect: input.minSelect ?? 0,
          maxSelect: input.maxSelect ?? 1,
          isRequired: input.isRequired ?? false,
          position: input.position ?? 0,
        } as never)
        .returning();

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'modifier_group.created',
        resourceType: 'modifier_group',
        resourceId: inserted[0]!.id,
        metadata: { name: input.name },
      });
      return inserted[0]!;
    });
  }

  async updateGroup(
    principal: Principal,
    branchId: string,
    groupId: string,
    input: Partial<ModifierGroupInput>,
  ) {
    const organizationId = await this.access.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const current = await this.loadGroup(tx, branchId, groupId);
      assertSelectRange({
        minSelect: input.minSelect ?? current.minSelect,
        maxSelect: input.maxSelect ?? current.maxSelect,
      });

      const updated = await tx
        .update(s.modifierGroups)
        .set({ ...input, updatedAt: new Date() } as never)
        .where(eq(s.modifierGroups.id, groupId))
        .returning();

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'modifier_group.updated',
        resourceType: 'modifier_group',
        resourceId: groupId,
        metadata: { changed: Object.keys(input) },
      });
      return updated[0]!;
    });
  }

  async deleteGroup(principal: Principal, branchId: string, groupId: string): Promise<void> {
    const organizationId = await this.access.assertAccess(principal, branchId);

    await this.db.withTenant(toTenantContext(principal), async (tx) => {
      await this.loadGroup(tx, branchId, groupId);
      const now = new Date();

      // As opções somem junto: um grupo removido não deixa respostas órfãs no
      // cardápio. Lógico dos dois lados, pelo histórico de pedidos.
      await tx
        .update(s.modifierOptions)
        .set({ deletedAt: now } as never)
        .where(eq(s.modifierOptions.modifierGroupId, groupId));
      await tx
        .update(s.modifierGroups)
        .set({ deletedAt: now } as never)
        .where(eq(s.modifierGroups.id, groupId));
      await tx
        .delete(s.productModifierGroups)
        .where(eq(s.productModifierGroups.modifierGroupId, groupId));

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'modifier_group.deleted',
        resourceType: 'modifier_group',
        resourceId: groupId,
      });
    });
  }

  async createOption(
    principal: Principal,
    branchId: string,
    groupId: string,
    input: ModifierOptionInput,
  ) {
    const organizationId = await this.access.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      await this.loadGroup(tx, branchId, groupId);

      const inserted = await tx
        .insert(s.modifierOptions)
        .values({
          id: uuidv7(),
          modifierGroupId: groupId,
          branchId,
          name: input.name,
          priceDeltaCents: input.priceDeltaCents ?? 0,
          isAvailable: input.isAvailable ?? true,
          position: input.position ?? 0,
        } as never)
        .returning();

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'modifier_option.created',
        resourceType: 'modifier_option',
        resourceId: inserted[0]!.id,
        metadata: { name: input.name, priceDeltaCents: input.priceDeltaCents ?? 0 },
      });
      return inserted[0]!;
    });
  }

  async updateOption(
    principal: Principal,
    branchId: string,
    optionId: string,
    input: Partial<ModifierOptionInput>,
  ) {
    const organizationId = await this.access.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.modifierOptions)
        .where(
          and(
            eq(s.modifierOptions.id, optionId),
            eq(s.modifierOptions.branchId, branchId),
            isNull(s.modifierOptions.deletedAt),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound('OPCAO_NAO_ENCONTRADA', 'Opção não encontrada');

      const updated = await tx
        .update(s.modifierOptions)
        .set({ ...input, updatedAt: new Date() } as never)
        .where(eq(s.modifierOptions.id, optionId))
        .returning();

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'modifier_option.updated',
        resourceType: 'modifier_option',
        resourceId: optionId,
        metadata: { changed: Object.keys(input) },
      });
      return updated[0]!;
    });
  }

  async deleteOption(principal: Principal, branchId: string, optionId: string): Promise<void> {
    const organizationId = await this.access.assertAccess(principal, branchId);

    await this.db.withTenant(toTenantContext(principal), async (tx) => {
      const updated = await tx
        .update(s.modifierOptions)
        .set({ deletedAt: new Date() } as never)
        .where(and(eq(s.modifierOptions.id, optionId), eq(s.modifierOptions.branchId, branchId)))
        .returning();
      if (!updated[0]) throw notFound('OPCAO_NAO_ENCONTRADA', 'Opção não encontrada');

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'modifier_option.deleted',
        resourceType: 'modifier_option',
        resourceId: optionId,
      });
    });
  }

  /** Define QUAIS grupos um produto usa, na ordem informada. */
  async setProductGroups(
    principal: Principal,
    branchId: string,
    productId: string,
    groupIds: string[],
  ): Promise<void> {
    const organizationId = await this.access.assertAccess(principal, branchId);

    await this.db.withTenant(toTenantContext(principal), async (tx) => {
      const product = await tx
        .select({ id: s.products.id })
        .from(s.products)
        .where(
          and(
            eq(s.products.id, productId),
            eq(s.products.branchId, branchId),
            isNull(s.products.deletedAt),
          ),
        )
        .limit(1);
      if (!product[0]) throw notFound('PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado');

      // Cada grupo é conferido contra ESTA unidade: um id de outra loja não
      // entra no cardápio daqui nem por engano nem de propósito.
      for (const groupId of groupIds) {
        await this.loadGroup(tx, branchId, groupId);
      }

      await tx
        .delete(s.productModifierGroups)
        .where(eq(s.productModifierGroups.productId, productId));

      if (groupIds.length > 0) {
        await tx.insert(s.productModifierGroups).values(
          groupIds.map((groupId, position) => ({
            productId,
            modifierGroupId: groupId,
            branchId,
            position,
          })) as never,
        );
      }

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'product.modifier_groups.set',
        resourceType: 'product',
        resourceId: productId,
        metadata: { groupIds },
      });
    });
  }

  private async loadGroup(tx: Db, branchId: string, groupId: string) {
    const rows = await tx
      .select()
      .from(s.modifierGroups)
      .where(
        and(
          eq(s.modifierGroups.id, groupId),
          eq(s.modifierGroups.branchId, branchId),
          isNull(s.modifierGroups.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound('GRUPO_NAO_ENCONTRADO', 'Grupo de opções não encontrado');
    return rows[0];
  }
}

/**
 * O banco tem a mesma CHECK, mas uma violação de constraint chega como erro de
 * banco. Aqui a recusa é explicável para quem está montando o cardápio.
 */
function assertSelectRange(input: { minSelect?: number; maxSelect?: number }): void {
  const min = input.minSelect ?? 0;
  const max = input.maxSelect ?? 1;
  if (max < min) {
    throw unprocessable(
      'ESCOLHA_INVALIDA',
      'O máximo de escolhas não pode ser menor que o mínimo',
    );
  }
}
