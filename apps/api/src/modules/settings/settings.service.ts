import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  openState,
  validateBusinessHours,
  type BusinessHour,
  type OpenState,
  type PaymentMethod,
} from '@plataforma/domain';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { notFound, unprocessable } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

/**
 * CONFIGURAÇÕES DA LOJA E HORÁRIO DE FUNCIONAMENTO.
 *
 * O horário existia no banco desde o começo (`business_hours`) mas nenhum
 * código o consultava — a loja nunca fechava. Aqui ele passa a valer, e vale no
 * SERVIDOR: o cardápio informa o estado para a tela avisar, e o checkout recusa
 * pedido com a loja fechada. Esconder o botão não é a regra; é a cortesia.
 */
export interface StoreSettingsView {
  branchId: string;
  preparationTimeMinutes: number;
  minOrderCents: number;
  autoAcceptOrders: boolean;
  paymentHoldMinutes: number;
  cancellationWindowMinutes: number;
  enabledPaymentMethods: PaymentMethod[];
  hours: BusinessHour[];
  open: OpenState;
}

export interface StoreSettingsInput {
  preparationTimeMinutes?: number;
  minOrderCents?: number;
  autoAcceptOrders?: boolean;
  paymentHoldMinutes?: number;
  cancellationWindowMinutes?: number;
  enabledPaymentMethods?: PaymentMethod[];
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BranchAccessService) private readonly access: BranchAccessService,
  ) {}

  async get(principal: Principal, branchId: string): Promise<StoreSettingsView> {
    await this.access.assertAccess(principal, branchId);
    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.storeSettings)
        .where(eq(s.storeSettings.branchId, branchId))
        .limit(1);
      const settings = rows[0];
      if (!settings) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada');

      const hours = await this.readHours(tx, branchId);
      return toView(branchId, settings, hours);
    });
  }

  async update(
    principal: Principal,
    branchId: string,
    input: StoreSettingsInput,
  ): Promise<StoreSettingsView> {
    const organizationId = await this.access.assertAccess(principal, branchId);

    if (input.enabledPaymentMethods && input.enabledPaymentMethods.length === 0) {
      // O banco também recusa (cardinality > 0), mas como erro de constraint.
      // Aqui o lojista entende o que fez.
      throw unprocessable(
        'PAGAMENTO_OBRIGATORIO',
        'A loja precisa aceitar ao menos uma forma de pagamento',
      );
    }

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const before = await tx
        .select()
        .from(s.storeSettings)
        .where(eq(s.storeSettings.branchId, branchId))
        .limit(1);
      if (!before[0]) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada');

      const updated = await tx
        .update(s.storeSettings)
        .set({ ...input, updatedAt: new Date() } as never)
        .where(eq(s.storeSettings.branchId, branchId))
        .returning();

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'settings.update',
        resourceType: 'store_settings',
        resourceId: branchId,
        // Só o que mudou: a trilha precisa mostrar a alteração, não repetir a
        // configuração inteira a cada salvamento.
        metadata: { changed: changedFields(before[0]!, input) },
      });

      const hours = await this.readHours(tx, branchId);
      return toView(branchId, updated[0]!, hours);
    });
  }

  /**
   * Grava o horário INTEIRO de uma vez.
   *
   * Substituição, e não edição faixa a faixa, porque a regra que importa é de
   * conjunto: duas faixas não podem se sobrepor. Validar isso em cima de um
   * estado parcial exigiria ler o que já está gravado e simular — trocar tudo
   * torna a validação local e o resultado previsível.
   */
  async replaceHours(
    principal: Principal,
    branchId: string,
    hours: BusinessHour[],
  ): Promise<StoreSettingsView> {
    const organizationId = await this.access.assertAccess(principal, branchId);

    const issues = validateBusinessHours(hours);
    if (issues.length > 0) {
      throw unprocessable('HORARIO_INVALIDO', issues.join('; '));
    }

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const before = await this.readHours(tx, branchId);

      await tx.delete(s.businessHours).where(eq(s.businessHours.branchId, branchId));
      if (hours.length > 0) {
        await tx.insert(s.businessHours).values(
          hours.map((hour) => ({
            branchId,
            organizationId,
            weekday: hour.weekday,
            opensAt: normalizeTime(hour.opensAt),
            closesAt: normalizeTime(hour.closesAt),
          })) as never,
        );
      }

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'settings.hours.replace',
        resourceType: 'business_hours',
        resourceId: branchId,
        metadata: { de: before, para: hours },
      });

      const settings = await tx
        .select()
        .from(s.storeSettings)
        .where(eq(s.storeSettings.branchId, branchId))
        .limit(1);
      const saved = await this.readHours(tx, branchId);
      return toView(branchId, settings[0]!, saved);
    });
  }

  /** Estado de abertura sem exigir sessão — usado pelo cardápio público. */
  async openStateOf(branchId: string, now = new Date()): Promise<OpenState> {
    const rows = await this.db.platform
      .select({
        weekday: s.businessHours.weekday,
        opensAt: s.businessHours.opensAt,
        closesAt: s.businessHours.closesAt,
      })
      .from(s.businessHours)
      .where(eq(s.businessHours.branchId, branchId));

    return openState(rows.map(toBusinessHour), now);
  }

  private async readHours(
    tx: { select: Database['platform']['select'] },
    branchId: string,
  ): Promise<BusinessHour[]> {
    const rows = await tx
      .select({
        weekday: s.businessHours.weekday,
        opensAt: s.businessHours.opensAt,
        closesAt: s.businessHours.closesAt,
      })
      .from(s.businessHours)
      .where(eq(s.businessHours.branchId, branchId));

    return rows
      .map(toBusinessHour)
      .sort((a, b) => a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt));
  }
}

/** Campos realmente alterados, para a trilha de auditoria. */
function changedFields(
  before: typeof s.storeSettings.$inferSelect,
  input: StoreSettingsInput,
): Record<string, { de: unknown; para: unknown }> {
  const changed: Record<string, { de: unknown; para: unknown }> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const previous = (before as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      changed[key] = { de: previous, para: value };
    }
  }
  return changed;
}

/** O PostgreSQL devolve `time` como `HH:MM:SS`; a API fala `HH:MM`. */
function toBusinessHour(row: { weekday: number; opensAt: string; closesAt: string }): BusinessHour {
  return {
    weekday: row.weekday as BusinessHour['weekday'],
    opensAt: row.opensAt.slice(0, 5),
    closesAt: row.closesAt.slice(0, 5),
  };
}

function normalizeTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

function toView(
  branchId: string,
  settings: typeof s.storeSettings.$inferSelect,
  hours: BusinessHour[],
): StoreSettingsView {
  return {
    branchId,
    preparationTimeMinutes: settings.preparationTimeMinutes,
    minOrderCents: Number(settings.minOrderCents),
    autoAcceptOrders: settings.autoAcceptOrders,
    paymentHoldMinutes: settings.paymentHoldMinutes,
    cancellationWindowMinutes: settings.cancellationWindowMinutes,
    enabledPaymentMethods: settings.enabledPaymentMethods as PaymentMethod[],
    hours,
    open: openState(hours),
  };
}
