import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { networkInterfaces } from 'node:os';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { notFound, unprocessable } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from '../../common/default-credentials.js';
import { AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';
import { loadEnv } from '../../config/env.js';
import {
  NORMALIZE_MESSAGE,
  normalizePublicBaseUrl,
  probePublicUrl,
  resolveShareBase,
  type ProbeFailure,
  type Reach,
  type ShareSource,
} from './public-url.js';

/**
 * LINK DO CARDÁPIO.
 *
 * O operador entrega ao cliente um endereço que o CELULAR DELE alcance — de
 * onde ele estiver. `localhost` nunca serve (levaria cada cliente ao próprio
 * telefone) e um IP de rede local (192.168.x.x) só serve dentro do Wi-Fi da
 * loja. O endereço bom é público e seguro (https); a ordem em que ele é
 * escolhido está em `resolveShareBase`.
 *
 * Tudo é resolvido no SERVIDOR: ele conhece o endereço cadastrado, a variável
 * PUBLIC_BASE_URL e o IP da máquina, e sabe por qual endereço o painel foi
 * aberto.
 */
export type ShareWarning =
  /** O link é público, mas a conta de demonstração ainda tem a senha publicada no README. */
  | 'DEFAULT_ADMIN_PASSWORD'
  /** O link é público, mas usa http: pedidos e pagamentos trafegariam sem criptografia. */
  | 'INSECURE_HTTP';

export interface ShareLink {
  organizationSlug: string;
  branchSlug: string;
  /** URL que vai no QR code. */
  menuUrl: string;
  /** Endereço-base (origem) em uso, sem o caminho da unidade. */
  baseUrl: string;
  /**
   * Até onde o link alcança:
   *  - `public`: qualquer celular, em qualquer rede;
   *  - `lan`: só quem está no mesmo Wi-Fi da loja;
   *  - `local`: só este computador.
   */
  reach: Reach;
  /** De onde veio o endereço (cadastrado, variável do servidor, painel, rede local). */
  source: ShareSource;
  secure: boolean;
  /** Endereço público cadastrado pelo dono para esta unidade; `null` se não houver. */
  publicBaseUrl: string | null;
  /** Endereço desta máquina na rede local, quando descoberto. */
  lanAddress: string | null;
  /** Legado: verdadeiro quando algum celular consegue abrir (ao menos no Wi-Fi da loja). */
  reachableFromPhones: boolean;
  warnings: ShareWarning[];
}

export interface ShareCheck {
  ok: boolean;
  reason?: ProbeFailure | 'NOT_PUBLIC';
  httpStatus?: number;
  checkedUrl: string;
}

/** Contexto da requisição HTTP: por qual origem o painel foi aberto. */
export interface ShareContext {
  requestOrigin: string | null;
}

/**
 * Endereço IPv4 desta máquina na rede local.
 *
 * Interfaces virtuais (Docker, WSL, VPN) existem na lista mas raramente são
 * alcançáveis pelo celular do cliente, então ficam por último.
 */
export function lanAddress(): string | null {
  const candidates: Array<{ address: string; virtual: boolean }> = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      candidates.push({
        address: address.address,
        virtual: /^(docker|br-|veth|vEthernet|VMware|VirtualBox|utun|tun)/i.test(name),
      });
    }
  }

  return (candidates.find((c) => !c.virtual) ?? candidates[0])?.address ?? null;
}

@Injectable()
export class StorefrontService {
  /** Trocável em teste: a verificação real faz uma chamada de rede. */
  probe: typeof probePublicUrl = probePublicUrl;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(BranchAccessService) private readonly access: BranchAccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  async shareLink(
    principal: Principal,
    branchId: string,
    context: ShareContext = { requestOrigin: null },
  ): Promise<ShareLink> {
    // Mesmo sendo um link para uma vitrine pública, o ESCOPO é verificado: o
    // operador de uma unidade não descobre o endereço de outra trocando o UUID.
    const organizationId = await this.access.assertAccess(principal, branchId);

    const { organizationSlug, branchSlug, publicBaseUrl } = await this.db.withTenant(
      toTenantContext(principal),
      async (tx) => {
        const rows = await tx
          .select({
            branchSlug: s.branches.slug,
            organizationSlug: s.organizations.slug,
            publicBaseUrl: s.storeSettings.publicBaseUrl,
          })
          .from(s.branches)
          .innerJoin(s.organizations, eq(s.organizations.id, s.branches.organizationId))
          .leftJoin(s.storeSettings, eq(s.storeSettings.branchId, s.branches.id))
          .where(eq(s.branches.id, branchId))
          .limit(1);

        const row = rows[0];
        if (!row) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada');
        return row;
      },
    );

    const address = lanAddress();
    const base = resolveShareBase({
      configured: publicBaseUrl,
      // Lido a cada chamada (e não na inicialização): o dono pode ter definido
      // a variável depois, e os testes alternam o valor.
      env: process.env.PUBLIC_BASE_URL ?? null,
      requestOrigin: context.requestOrigin,
      lanAddress: address,
      port: loadEnv().PORT,
    });

    const warnings: ShareWarning[] = [];
    if (base.reach === 'public') {
      if (!base.secure) warnings.push('INSECURE_HTTP');
      if (await this.hasDefaultAdminPassword(organizationId)) warnings.push('DEFAULT_ADMIN_PASSWORD');
    }

    return {
      organizationSlug,
      branchSlug,
      menuUrl: `${base.origin}/${organizationSlug}/${branchSlug}`,
      baseUrl: base.origin,
      reach: base.reach,
      source: base.source,
      secure: base.secure,
      publicBaseUrl,
      lanAddress: address,
      reachableFromPhones: base.reach !== 'local',
      warnings,
    };
  }

  /**
   * Cadastra (ou remove, com `null`) o endereço público desta unidade.
   *
   * Recusa publicar enquanto a conta de demonstração tiver a senha padrão:
   * ela está no README, e o painel que ela abre controla a chave Pix da loja.
   */
  async setPublicBaseUrl(
    principal: Principal,
    branchId: string,
    input: string | null,
    context: ShareContext,
  ): Promise<ShareLink> {
    const organizationId = await this.access.assertAccess(principal, branchId);

    let origin: string | null = null;
    if (input !== null && input.trim() !== '') {
      const normalized = normalizePublicBaseUrl(input);
      if (!normalized.ok) {
        throw unprocessable('ENDERECO_INVALIDO', NORMALIZE_MESSAGE[normalized.code], {
          reason: normalized.code,
        });
      }
      origin = normalized.origin;

      if (await this.hasDefaultAdminPassword(organizationId)) {
        throw unprocessable(
          'SENHA_PADRAO_ATIVA',
          'Troque a senha da conta de demonstração antes de publicar o cardápio na internet.',
        );
      }
    }

    await this.db.withTenant(toTenantContext(principal), async (tx) => {
      const updated = await tx
        .update(s.storeSettings)
        .set({ publicBaseUrl: origin })
        .where(eq(s.storeSettings.branchId, branchId))
        .returning({ branchId: s.storeSettings.branchId });
      if (updated.length === 0) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada');

      await this.audit.record(tx, {
        principal,
        organizationId,
        branchId,
        action: 'share_link.updated',
        resourceType: 'store_settings',
        resourceId: branchId,
        metadata: { publicBaseUrl: origin },
      });
    });

    return this.shareLink(principal, branchId, context);
  }

  /**
   * Confere, do lado do servidor, que o endereço em uso abre ESTE sistema.
   *
   * A chamada sai do servidor da loja para a internet e volta: é o teste mais
   * próximo do que o celular de um cliente fará. Um erro aqui não prova que o
   * link esteja quebrado (o roteador de casa pode não "dar a volta" para o
   * próprio endereço), então a tela fala em "não conseguimos confirmar".
   */
  async checkLink(principal: Principal, branchId: string, context: ShareContext): Promise<ShareCheck> {
    const link = await this.shareLink(principal, branchId, context);
    if (link.reach !== 'public') {
      return { ok: false, reason: 'NOT_PUBLIC', checkedUrl: link.menuUrl };
    }

    const result = await this.probe(
      link.baseUrl,
      { organizationSlug: link.organizationSlug, branchId },
      { allowPrivateTargets: loadEnv().PUBLIC_URL_PROBE_ALLOW_PRIVATE },
    );
    return result.ok
      ? { ok: true, checkedUrl: link.menuUrl }
      : { ok: false, reason: result.reason, httpStatus: result.httpStatus, checkedUrl: link.menuUrl };
  }

  /** A conta de demonstração desta organização ainda aceita a senha publicada no README? */
  private async hasDefaultAdminPassword(organizationId: string): Promise<boolean> {
    const rows = await this.db.platform
      .select({ passwordHash: s.users.passwordHash })
      .from(s.users)
      .where(
        and(
          eq(s.users.organizationId, organizationId),
          eq(s.users.email, DEFAULT_ADMIN_EMAIL),
          eq(s.users.type, 'STAFF'),
          eq(s.users.isActive, true),
          isNull(s.users.deletedAt),
        ),
      )
      .limit(1);
    const hash = rows[0]?.passwordHash;
    if (!hash) return false;
    return this.passwords.verify(hash, DEFAULT_ADMIN_PASSWORD);
  }
}
