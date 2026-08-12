import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { networkInterfaces } from 'node:os';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { notFound } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';
import { loadEnv } from '../../config/env.js';

/**
 * LINK DO CARDÁPIO.
 *
 * O operador precisa entregar ao cliente um endereço que o CELULAR DELE
 * alcance. Isso descarta `localhost`: o painel do operador roda na máquina do
 * restaurante, e um QR code apontando para localhost levaria cada cliente ao
 * próprio telefone.
 *
 * Por isso o endereço é resolvido no SERVIDOR, e não a partir de
 * `window.location` no navegador do operador.
 */
export interface ShareLink {
  organizationSlug: string;
  branchSlug: string;
  /** URL que vai no QR code. */
  menuUrl: string;
  /** Endereço desta máquina na rede local, quando descoberto. */
  lanAddress: string | null;
  /**
   * Falso quando só foi possível montar um endereço local — o cardápio abre
   * nesta máquina, mas não no celular do cliente. A tela avisa em vez de
   * exibir um QR code que não funciona.
   */
  reachableFromPhones: boolean;
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
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(BranchAccessService) private readonly access: BranchAccessService,
  ) {}

  async shareLink(principal: Principal, branchId: string): Promise<ShareLink> {
    // Mesmo sendo um link para uma vitrine pública, o ESCOPO é verificado: o
    // operador de uma unidade não descobre o endereço de outra trocando o UUID.
    await this.access.assertAccess(principal, branchId);

    const { organizationSlug, branchSlug } = await this.db.withTenant(
      toTenantContext(principal),
      async (tx) => {
        const rows = await tx
          .select({
            branchSlug: s.branches.slug,
            organizationSlug: s.organizations.slug,
          })
          .from(s.branches)
          .innerJoin(s.organizations, eq(s.organizations.id, s.branches.organizationId))
          .where(eq(s.branches.id, branchId))
          .limit(1);

        const row = rows[0];
        if (!row) throw notFound('UNIDADE_NAO_ENCONTRADA', 'Unidade não encontrada');
        return row;
      },
    );

    const path = `/${organizationSlug}/${branchSlug}`;

    // Quando o launcher já sabe o endereço, ele manda — é a mesma origem que
    // ele imprimiu no console, então painel e QR code nunca divergem.
    const configured = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
    if (configured) {
      return {
        organizationSlug,
        branchSlug,
        menuUrl: `${configured}${path}`,
        lanAddress: lanAddress(),
        reachableFromPhones: !/localhost|127\.0\.0\.1/.test(configured),
      };
    }

    const address = lanAddress();
    const port = loadEnv().PORT;
    return {
      organizationSlug,
      branchSlug,
      menuUrl: `http://${address ?? 'localhost'}:${port}${path}`,
      lanAddress: address,
      reachableFromPhones: address !== null,
    };
  }
}
