import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { notFound } from '../../common/errors.js';
import type { Principal } from '../../common/principal.js';

/**
 * Verificação de escopo de unidade, contra o BANCO.
 *
 * Por que não basta olhar o principal: um usuário com concessão de organização
 * inteira (`branch_id NULL`) tem `isOrgWide = true`. Uma checagem puramente
 * em memória — "é org-wide, então pode" — aceita QUALQUER branchId, inclusive
 * de outra franquia. A RLS ainda devolveria vazio, mas a API responderia 200,
 * confirmando ao atacante que a requisição foi aceita e deixando o escopo
 * dependente de uma única camada.
 *
 * Este serviço fecha isso carregando a unidade e comparando a organização —
 * a autoridade é sempre o registro no banco, nunca o ID da URL.
 *
 * Recurso fora do escopo devolve 404, nunca 403: um 403 confirmaria que a
 * unidade existe.
 */
@Injectable()
export class BranchAccessService {
  private readonly cache = new Map<string, { organizationId: string; at: number }>();

  constructor(@Inject(Database) private readonly db: Database) {}

  async assertAccess(principal: Principal, branchId: string): Promise<string> {
    const organizationId = await this.organizationOf(branchId);
    if (!organizationId) throw notFound();

    if (principal.isPlatformAdmin) return organizationId;

    // A unidade precisa ser da MESMA organização do ator.
    if (principal.organizationId !== organizationId) throw notFound();

    // Escopo de organização inteira cobre todas as unidades DELA.
    if (principal.isOrgWide) return organizationId;

    if (!principal.branchScope.includes(branchId)) throw notFound();
    return organizationId;
  }

  private async organizationOf(branchId: string): Promise<string | null> {
    const cached = this.cache.get(branchId);
    if (cached && Date.now() - cached.at < 30_000) return cached.organizationId;

    const rows = await this.db.platform
      .select({ organizationId: s.branches.organizationId })
      .from(s.branches)
      .where(and(eq(s.branches.id, branchId), isNull(s.branches.deletedAt)))
      .limit(1);

    const organizationId = rows[0]?.organizationId ?? null;
    if (organizationId) this.cache.set(branchId, { organizationId, at: Date.now() });
    return organizationId;
  }
}
