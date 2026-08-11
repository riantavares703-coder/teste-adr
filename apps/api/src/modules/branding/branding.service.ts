import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_BRANDING,
  resolveTheme,
  validateBranding,
  type BrandingInput,
  type NormalizedBranding,
} from '@plataforma/domain';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { notFound, unprocessable } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

/**
 * APARÊNCIA DA UNIDADE.
 *
 * Três coisas acontecem aqui, e a ordem importa:
 *
 *  1. ESCOPO — `BranchAccessService` confirma que esta unidade é alcançável por
 *     este usuário. Trocar o UUID na URL não muda a loja de ninguém.
 *  2. VALIDAÇÃO — as MESMAS regras do preview (`@plataforma/domain`), aplicadas
 *     de novo no servidor. O app validar antes é conveniência; aqui é decisão.
 *  3. AUDITORIA — quem mudou o quê, com o valor anterior.
 *
 * O ponto do item 10 do briefing: "nunca confiar em permissões do frontend".
 * O editor de aparência só abre para quem tem `branding:update`, mas quem
 * recusa é este serviço.
 */
export interface BrandingView extends NormalizedBranding {
  branchId: string;
  logoUrl: string | null;
  iconUrl: string | null;
  coverUrl: string | null;
  updatedAt: string | null;
}

@Injectable()
export class BrandingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BranchAccessService) private readonly access: BranchAccessService,
  ) {}

  /** Leitura para a área administrativa (exige escopo). */
  async get(principal: Principal, branchId: string): Promise<BrandingView> {
    await this.access.assertAccess(principal, branchId);
    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.brandingSettings)
        .where(eq(s.brandingSettings.branchId, branchId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        // Unidade sem branding gravado ainda: devolvemos o PADRÃO, não 404.
        // A tela de aparência precisa mostrar o que está no ar, e o que está no
        // ar nesse caso é exatamente o padrão da plataforma.
        return {
          branchId,
          ...DEFAULT_BRANDING,
          logoUrl: null,
          iconUrl: null,
          coverUrl: null,
          updatedAt: null,
        };
      }
      return toView(branchId, row);
    });
  }

  /**
   * Grava a identidade visual.
   *
   * Recusa por 422 com a lista de problemas — inclusive os de CONTRASTE. Um
   * cardápio ilegível é um defeito de acessibilidade que atinge todo cliente da
   * loja; não é preferência estética do lojista.
   */
  async update(
    principal: Principal,
    branchId: string,
    input: BrandingInput,
  ): Promise<BrandingView> {
    const organizationId = await this.access.assertAccess(principal, branchId);

    const { ok, issues, value } = validateBranding(input);
    if (!ok) {
      throw unprocessable('APARENCIA_INVALIDA', 'Não foi possível aplicar esta identidade visual.', {
        issues,
      });
    }

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const before = (
        await tx
          .select()
          .from(s.brandingSettings)
          .where(eq(s.brandingSettings.branchId, branchId))
          .limit(1)
      )[0];

      const columns = {
        displayName: value.displayName,
        tagline: value.tagline,
        primaryColor: value.primaryColor,
        secondaryColor: value.secondaryColor,
        accentColor: value.accentColor,
        textColor: value.textColor,
        backgroundColor: value.backgroundColor,
        cardColor: value.cardColor,
        fontToken: value.fontToken,
        gradientStyle: value.gradientStyle,
        gradientFrom: value.gradientFrom,
        gradientTo: value.gradientTo,
        updatedBy: principal.userId,
      };

      const [row] = await tx
        .insert(s.brandingSettings)
        .values({ branchId, organizationId, ...columns })
        .onConflictDoUpdate({ target: s.brandingSettings.branchId, set: columns })
        .returning();

      if (!row) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Estabelecimento não encontrado');

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'branding.update',
        resourceType: 'branding_settings',
        resourceId: branchId,
        metadata: {
          // Só o que MUDOU. Auditar o objeto inteiro a cada salvamento enche a
          // trilha de ruído e esconde a alteração relevante.
          changed: diff(before ?? null, columns),
        },
      });

      return toView(branchId, row);
    });
  }

  /**
   * Vitrine pública: o tema já RESOLVIDO.
   *
   * O app do cliente não recebe a configuração crua — recebe o tema pronto,
   * com as cores derivadas (texto sobre botão, borda, sobreposição) já
   * calculadas pelo servidor. Assim o cálculo é o mesmo para todo mundo, e um
   * app desatualizado não renderiza uma variação diferente.
   */
  async publicTheme(branchId: string) {
    const rows = await this.db.platform
      .select()
      .from(s.brandingSettings)
      .where(eq(s.brandingSettings.branchId, branchId))
      .limit(1);
    return themeOf(rows[0] ?? null);
  }
}

type BrandingRow = typeof s.brandingSettings.$inferSelect;

function toView(branchId: string, row: BrandingRow): BrandingView {
  const { value } = validateBranding(rowToInput(row));
  return {
    branchId,
    ...value,
    logoUrl: mediaUrl(row.logoStorageKey),
    iconUrl: mediaUrl(row.iconStorageKey),
    coverUrl: mediaUrl(row.coverStorageKey),
    updatedAt: null,
  };
}

export function rowToInput(row: BrandingRow | null): BrandingInput {
  if (!row) return {};
  return {
    displayName: row.displayName,
    tagline: row.tagline,
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    accentColor: row.accentColor,
    textColor: row.textColor,
    backgroundColor: row.backgroundColor,
    cardColor: row.cardColor,
    fontToken: row.fontToken,
    gradientStyle: row.gradientStyle,
    gradientFrom: row.gradientFrom,
    gradientTo: row.gradientTo,
  };
}

/** Tema resolvido + as imagens, no formato que o app consome. */
export function themeOf(row: BrandingRow | null) {
  return {
    ...resolveTheme(rowToInput(row)),
    displayName: row?.displayName ?? null,
    tagline: row?.tagline ?? null,
    logoUrl: mediaUrl(row?.logoStorageKey ?? null),
    iconUrl: mediaUrl(row?.iconStorageKey ?? null),
    coverUrl: mediaUrl(row?.coverStorageKey ?? null),
  };
}

function mediaUrl(key: string | null | undefined): string | null {
  return key ? `/v1/media/${key}` : null;
}

function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Record<string, { de: unknown; para: unknown }> {
  const changed: Record<string, { de: unknown; para: unknown }> = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === 'updatedBy') continue;
    const previous = before?.[key] ?? null;
    if (previous !== value) changed[key] = { de: previous, para: value };
  }
  return changed;
}
