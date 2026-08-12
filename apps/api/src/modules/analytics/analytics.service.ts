import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '../../db/client.js';
import { badRequest, notFound } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

/**
 * INDICADORES CONSOLIDADOS DA FRANQUIA (Prompt 03, item 8).
 *
 * ---------------------------------------------------------------------------
 * O RISCO ESPECÍFICO DESTE MÓDULO
 * ---------------------------------------------------------------------------
 * Agregação é o jeito mais silencioso de vazar dado entre unidades. Um endpoint
 * que devolve "faturamento total" pode expor o desempenho de uma unidade que o
 * usuário não pode ver — sem nunca devolver uma única linha de `orders`. E como
 * o resultado é um número só, nenhum teste de "não vejo o pedido do outro"
 * pega isso.
 *
 * Três camadas respondem por esse risco:
 *
 *  1. O ESCOPO É CALCULADO NO SERVIDOR, não recebido. O cliente pede um
 *     período; quem decide QUAIS unidades entram na conta é
 *     `resolveScope()`, a partir do papel.
 *  2. Cada unidade pedida explicitamente passa por `assertAccess`, que devolve
 *     404 (não 403) para unidade de outra franquia.
 *  3. A consulta roda sob RLS com o contexto do usuário. Mesmo que um `WHERE`
 *     seja esquecido aqui, o banco não devolve linha de outro tenant — o
 *     agregado sai menor, nunca maior.
 *
 * A camada 3 é a que garante que um erro meu não vira incidente.
 */

export interface AnalyticsQuery {
  /** Janela em dias, contada para trás a partir de agora. */
  days: number;
  /** Unidade específica; ausente = todas as que o usuário alcança. */
  branchId?: string;
}

export interface BranchIndicator {
  branchId: string;
  branchName: string;
  orderCount: number;
  revenueCents: number;
  averageTicketCents: number;
}

export interface AnalyticsSummary {
  periodDays: number;
  since: string;
  scope: 'ORGANIZATION' | 'BRANCHES';
  branchCount: number;
  totals: {
    orderCount: number;
    revenueCents: number;
    averageTicketCents: number;
    cancelledCount: number;
  };
  byBranch: BranchIndicator[];
  topProducts: Array<{
    productId: string;
    productName: string;
    quantity: number;
    revenueCents: number;
  }>;
}

const MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RevenueQuery {
  days: number;
  branchId?: string;
}

export interface PeriodTotals {
  orderCount: number;
  revenueCents: number;
  averageTicketCents: number;
}

export interface RevenueReport {
  periodDays: number;
  since: string;
  /** Granularidade escolhida pelo servidor conforme o tamanho do intervalo. */
  bucket: 'day' | 'week' | 'month';
  scope: 'ORGANIZATION' | 'BRANCHES';
  current: PeriodTotals;
  /** Mesma duração, imediatamente antes — é o que dá sentido ao número atual. */
  previous: PeriodTotals;
  change: { revenuePercent: number | null; orderPercent: number | null };
  series: Array<{ date: string; orderCount: number; revenueCents: number }>;
}

/**
 * Variação percentual entre dois períodos.
 *
 * Devolve `null` quando o período anterior foi zero: "cresceu 100%" a partir de
 * nada é uma afirmação sem conteúdo, e dividir por zero produziria `Infinity`
 * na tela. A tela mostra "sem base de comparação" e diz a verdade.
 */
function percentChange(before: number, after: number): number | null {
  if (before === 0) return null;
  return Math.round(((after - before) / before) * 1000) / 10;
}

/**
 * O que conta como faturamento.
 *
 * Só pedido CONCLUÍDO. Pedido cancelado, expirado ou ainda em preparo não é
 * receita — e somar tudo produziria um número que não fecha com o caixa. A
 * definição vive aqui, uma vez, para que o total e o por-unidade não possam
 * divergir.
 */
const REVENUE_STATUSES = sql`('DELIVERED','PICKED_UP')`;

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(BranchAccessService) private readonly access: BranchAccessService,
  ) {}

  async summary(principal: Principal, query: AnalyticsQuery): Promise<AnalyticsSummary> {
    const days = Math.floor(query.days);
    if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
      throw badRequest('PERIODO_INVALIDO', `Informe um período entre 1 e ${MAX_DAYS} dias.`);
    }

    const scope = await this.resolveScope(principal, query.branchId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      // Filtro de unidade em SQL. Lista vazia significa "toda a organização",
      // e nesse caso é a RLS que delimita — não um IN vazio, que devolveria
      // zero linhas e daria a impressão errada de "loja sem movimento".
      const branchFilter =
        scope.branchIds.length > 0
          ? sql`AND o.branch_id IN (${sql.join(
              scope.branchIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``;

      const byBranch = await tx.execute<{
        branch_id: string;
        branch_name: string;
        order_count: string;
        revenue_cents: string;
      }>(sql`
        SELECT b.id                                   AS branch_id,
               b.name                                 AS branch_name,
               count(o.id) FILTER (WHERE o.status IN ${REVENUE_STATUSES})       AS order_count,
               COALESCE(sum(o.total_cents) FILTER (WHERE o.status IN ${REVENUE_STATUSES}), 0) AS revenue_cents
          FROM branches b
          LEFT JOIN orders o
                 ON o.branch_id = b.id
                AND o.placed_at >= ${since.toISOString()}
          WHERE b.deleted_at IS NULL
            ${
              scope.branchIds.length > 0
                ? sql`AND b.id IN (${sql.join(
                    scope.branchIds.map((id) => sql`${id}::uuid`),
                    sql`, `,
                  )})`
                : sql``
            }
          GROUP BY b.id, b.name
          ORDER BY revenue_cents DESC, b.name ASC
      `);

      const cancelled = await tx.execute<{ count: string }>(sql`
        SELECT count(*) AS count
          FROM orders o
         WHERE o.placed_at >= ${since.toISOString()}
           AND o.status IN ('CANCELLED','REJECTED','EXPIRED')
           ${branchFilter}
      `);

      const topProducts = await tx.execute<{
        product_id: string;
        product_name: string;
        quantity: string;
        revenue_cents: string;
      }>(sql`
        SELECT i.product_id,
               -- O nome vem do SNAPSHOT do item, não do produto atual: se o
               -- lojista renomeou "X-Burger" para "Burger da Casa" ontem, o
               -- relatório continua refletindo o que foi vendido.
               max(i.product_name_snapshot) AS product_name,
               sum(i.quantity)              AS quantity,
               sum(i.line_total_cents)      AS revenue_cents
          FROM order_items i
          JOIN orders o ON o.id = i.order_id
         WHERE o.placed_at >= ${since.toISOString()}
           AND o.status IN ${REVENUE_STATUSES}
           ${branchFilter}
         GROUP BY i.product_id
         ORDER BY quantity DESC
         LIMIT 10
      `);

      const branches: BranchIndicator[] = rowsOf(byBranch).map((row) => {
        const orderCount = Number(row.order_count);
        const revenueCents = Number(row.revenue_cents);
        return {
          branchId: row.branch_id,
          branchName: row.branch_name,
          orderCount,
          revenueCents,
          averageTicketCents: averageTicket(revenueCents, orderCount),
        };
      });

      const orderCount = branches.reduce((sum, b) => sum + b.orderCount, 0);
      const revenueCents = branches.reduce((sum, b) => sum + b.revenueCents, 0);

      return {
        periodDays: days,
        since: since.toISOString(),
        scope: scope.kind,
        branchCount: branches.length,
        totals: {
          orderCount,
          revenueCents,
          averageTicketCents: averageTicket(revenueCents, orderCount),
          cancelledCount: Number(rowsOf(cancelled)[0]?.count ?? 0),
        },
        byBranch: branches,
        topProducts: rowsOf(topProducts).map((row) => ({
          productId: row.product_id,
          productName: row.product_name,
          quantity: Number(row.quantity),
          revenueCents: Number(row.revenue_cents),
        })),
      };
    });
  }

  /**
   * FATURAMENTO AO LONGO DO TEMPO, com comparação contra o período anterior.
   *
   * Duas perguntas que o total sozinho não responde: "como foi a semana, dia a
   * dia" e "isso é melhor ou pior que antes". A segunda é a que importa para
   * decidir alguma coisa — R$ 40 mil no trimestre não significa nada até se
   * saber que o anterior fez R$ 52 mil.
   *
   * O período anterior tem exatamente a mesma duração e termina onde o atual
   * começa. Comparar contra "mês passado" pelo calendário compararia 28 com 31
   * dias, e fevereiro pareceria sempre um desastre.
   *
   * A agregação por dia é feita no BANCO (`date_trunc`), não em memória: o
   * intervalo pode ser de um ano, e trazer todos os pedidos para somar no
   * processo seria carregar milhares de linhas para devolver 365 números.
   */
  async revenue(principal: Principal, query: RevenueQuery): Promise<RevenueReport> {
    const days = Math.floor(query.days);
    if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
      throw badRequest('PERIODO_INVALIDO', `Informe um período entre 1 e ${MAX_DAYS} dias.`);
    }

    const scope = await this.resolveScope(principal, query.branchId);
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY_MS);
    const previousSince = new Date(since.getTime() - days * DAY_MS);

    // Dia, semana ou mês conforme o tamanho do intervalo: 365 pontos diários
    // num gráfico de um ano viram ruído; 12 pontos mensais contam a história.
    const bucket = days <= 31 ? 'day' : days <= 180 ? 'week' : 'month';

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const branchFilter =
        scope.branchIds.length > 0
          ? sql`AND o.branch_id IN (${sql.join(
              scope.branchIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``;

      const series = await tx.execute<{
        bucket: string;
        order_count: string;
        revenue_cents: string;
      }>(sql`
        SELECT date_trunc(${bucket}, o.placed_at)::date::text AS bucket,
               count(*)                      AS order_count,
               COALESCE(sum(o.total_cents),0) AS revenue_cents
          FROM orders o
         WHERE o.placed_at >= ${since.toISOString()}
           AND o.status IN ${REVENUE_STATUSES}
           ${branchFilter}
         GROUP BY 1
         ORDER BY 1
      `);

      /**
       * Os dois períodos numa consulta só, separados por CASE.
       *
       * Duas consultas dariam o mesmo número, mas com a chance de caírem em
       * lados diferentes da virada do dia se o relógio passar da meia-noite
       * entre elas.
       */
      const compared = await tx.execute<{
        periodo: string;
        order_count: string;
        revenue_cents: string;
      }>(sql`
        SELECT CASE WHEN o.placed_at >= ${since.toISOString()} THEN 'atual' ELSE 'anterior' END AS periodo,
               count(*)                       AS order_count,
               COALESCE(sum(o.total_cents),0) AS revenue_cents
          FROM orders o
         WHERE o.placed_at >= ${previousSince.toISOString()}
           AND o.status IN ${REVENUE_STATUSES}
           ${branchFilter}
         GROUP BY 1
      `);

      const rows = rowsOf(compared);
      const current = rows.find((row) => row.periodo === 'atual');
      const previous = rows.find((row) => row.periodo === 'anterior');

      const currentRevenue = Number(current?.revenue_cents ?? 0);
      const previousRevenue = Number(previous?.revenue_cents ?? 0);
      const currentOrders = Number(current?.order_count ?? 0);
      const previousOrders = Number(previous?.order_count ?? 0);

      return {
        periodDays: days,
        since: since.toISOString(),
        bucket,
        scope: scope.kind,
        current: {
          orderCount: currentOrders,
          revenueCents: currentRevenue,
          averageTicketCents: averageTicket(currentRevenue, currentOrders),
        },
        previous: {
          orderCount: previousOrders,
          revenueCents: previousRevenue,
          averageTicketCents: averageTicket(previousRevenue, previousOrders),
        },
        change: {
          revenuePercent: percentChange(previousRevenue, currentRevenue),
          orderPercent: percentChange(previousOrders, currentOrders),
        },
        series: rowsOf(series).map((row) => ({
          date: row.bucket,
          orderCount: Number(row.order_count),
          revenueCents: Number(row.revenue_cents),
        })),
      };
    });
  }

  /**
   * Decide QUAIS unidades entram na conta.
   *
   * É o coração da separação entre "administrador da franquia" e "operador
   * comum" pedida no item 8: o segundo enxerga apenas a unidade autorizada,
   * mesmo chamando o mesmo endpoint sem parâmetro nenhum.
   */
  private async resolveScope(
    principal: Principal,
    requestedBranchId?: string,
  ): Promise<{ kind: 'ORGANIZATION' | 'BRANCHES'; branchIds: string[] }> {
    if (requestedBranchId) {
      // Unidade de outra franquia vira 404 aqui dentro — nunca chega à consulta.
      await this.access.assertAccess(principal, requestedBranchId);
      return { kind: 'BRANCHES', branchIds: [requestedBranchId] };
    }

    if (principal.isPlatformAdmin) {
      throw badRequest(
        'UNIDADE_OBRIGATORIA',
        'Informe a organização ou a unidade a consultar.',
      );
    }

    if (principal.isOrgWide) {
      if (!principal.organizationId) throw notFound();
      // Lista vazia + RLS = todas as unidades da organização.
      return { kind: 'ORGANIZATION', branchIds: [] };
    }

    if (principal.branchScope.length === 0) {
      throw notFound('SEM_UNIDADE', 'Nenhuma unidade associada ao seu usuário.');
    }
    return { kind: 'BRANCHES', branchIds: [...principal.branchScope] };
  }
}

/** Ticket médio em centavos, arredondado. Sem pedido, é zero — nunca NaN. */
function averageTicket(revenueCents: number, orderCount: number): number {
  return orderCount > 0 ? Math.round(revenueCents / orderCount) : 0;
}

/**
 * `drizzle.execute` devolve `{ rows }` no driver `pg` e um array simples em
 * outros drivers. Normalizamos aqui em vez de espalhar o `.rows` pelas consultas.
 */
function rowsOf<T>(result: { rows: T[] } | T[]): T[] {
  if (Array.isArray(result)) return result;
  return Array.isArray(result.rows) ? result.rows : [];
}
