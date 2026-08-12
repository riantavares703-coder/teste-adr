import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsSummary, RevenueReport } from '@plataforma/client';
import { formatBRL } from '@plataforma/domain';
import { ErrorState, Price, Skeleton, friendlyMessage } from '@plataforma/ui-web';
import { useSession } from '../session';

/**
 * DASHBOARD FINANCEIRO.
 *
 * A pergunta que o dono do restaurante faz não é "quanto entrou" — é "quanto
 * entrou COMPARADO a antes". Por isso todo número grande vem acompanhado da
 * variação contra o período anterior de mesma duração, e o gráfico mostra a
 * forma do movimento, não só o total.
 *
 * Nenhum cálculo acontece aqui: série, comparação e percentual vêm do servidor,
 * onde o escopo por franquia é resolvido. A tela desenha.
 */
const PERIODS = [
  { label: 'Hoje', days: 1 },
  { label: '7 dias', days: 7 },
  { label: 'Mês', days: 30 },
  { label: 'Trimestre', days: 90 },
  { label: 'Semestre', days: 180 },
  { label: 'Ano', days: 365 },
] as const;

export function DashboardPage() {
  const { api, branch, profile } = useSession();

  const [days, setDays] = useState(30);
  const [revenue, setRevenue] = useState<RevenueReport | null>(null);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // Administrador da franquia vê a organização inteira; os demais, a unidade.
  // Quem decide é o servidor — aqui só evitamos mandar um filtro desnecessário.
  const branchFilter = profile.isOrgWide ? undefined : branch.id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [loadedRevenue, loadedSummary] = await Promise.all([
        api.getRevenue({ days, branchId: branchFilter }),
        api.getAnalytics({ days, branchId: branchFilter }),
      ]);
      setRevenue(loadedRevenue);
      setSummary(loadedSummary);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, days, branchFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <div className="dash__head">
        <h2>Faturamento</h2>
        <div className="dash__periods" role="group" aria-label="Período">
          {PERIODS.map((period) => (
            <button
              key={period.days}
              type="button"
              className={days === period.days ? 'dash__period dash__period--on' : 'dash__period'}
              aria-pressed={days === period.days}
              onClick={() => setDays(period.days)}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <ErrorState message={friendlyMessage(error)} onRetry={() => void load()} />
      ) : loading || !revenue ? (
        <div className="dash__grid">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} height={104} radius={20} />
          ))}
        </div>
      ) : (
        <>
          <div className="dash__grid">
            <BigStat
              label="Recebido no período"
              value={formatBRL(revenue.current.revenueCents)}
              percent={revenue.change.revenuePercent}
              previous={`antes: ${formatBRL(revenue.previous.revenueCents)}`}
            />
            <BigStat
              label="Pedidos"
              value={String(revenue.current.orderCount)}
              percent={revenue.change.orderPercent}
              previous={`antes: ${revenue.previous.orderCount}`}
            />
            <BigStat
              label="Ticket médio"
              value={formatBRL(revenue.current.averageTicketCents)}
              previous={`antes: ${formatBRL(revenue.previous.averageTicketCents)}`}
            />
            <BigStat
              label="Cancelados"
              value={String(summary?.totals.cancelledCount ?? 0)}
              tone={summary && summary.totals.cancelledCount > 0 ? 'warn' : undefined}
            />
          </div>

          <RevenueChart report={revenue} />

          <div className="dash__cols">
            <div className="ui-card">
              <h3>Mais vendidos</h3>
              {summary && summary.topProducts.length > 0 ? (
                <ol className="rank">
                  {summary.topProducts.map((product, index) => (
                    <li key={product.productId}>
                      <span className="rank__pos tnum">{index + 1}</span>
                      <span className="rank__name">{product.productName}</span>
                      <span className="rank__qty tnum">{product.quantity} un.</span>
                      <Price cents={product.revenueCents} />
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="dash__empty">Sem vendas no período.</p>
              )}
            </div>

            {summary && summary.scope === 'ORGANIZATION' ? (
              <div className="ui-card">
                <h3>Por unidade</h3>
                <ol className="rank">
                  {summary.byBranch.map((unit, index) => (
                    <li key={unit.branchId}>
                      <span className="rank__pos tnum">{index + 1}</span>
                      <span className="rank__name">{unit.branchName}</span>
                      <span className="rank__qty tnum">{unit.orderCount} ped.</span>
                      <Price cents={unit.revenueCents} />
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function BigStat({
  label,
  value,
  percent,
  previous,
  tone,
}: {
  label: string;
  value: string;
  percent?: number | null;
  previous?: string;
  tone?: 'warn';
}) {
  return (
    <div className={`bigstat ${tone === 'warn' ? 'bigstat--warn' : ''}`}>
      <span className="bigstat__label">{label}</span>
      <strong className="bigstat__value tnum">{value}</strong>

      <div className="bigstat__foot">
        {percent !== undefined ? (
          percent === null ? (
            // Crescer "100%" a partir de zero não informa nada; dizer isso é
            // mais honesto que exibir um número inventado.
            <span className="delta delta--none">sem base de comparação</span>
          ) : (
            <span className={`delta ${percent >= 0 ? 'delta--up' : 'delta--down'}`}>
              {percent >= 0 ? '▲' : '▼'} {Math.abs(percent).toLocaleString('pt-BR')}%
            </span>
          )
        ) : null}
        {previous ? <span className="bigstat__prev">{previous}</span> : null}
      </div>
    </div>
  );
}

const BUCKET_LABEL: Record<RevenueReport['bucket'], string> = {
  day: 'por dia',
  week: 'por semana',
  month: 'por mês',
};

/**
 * Gráfico de barras em CSS puro.
 *
 * Sem biblioteca de gráficos por uma razão prática: o sistema roda na rede
 * local do restaurante, e cada dependência é mais peso para baixar num
 * primeiro acesso que já baixa o banco de dados. Barras proporcionais dão a
 * forma do movimento, que é o que a pergunta exige.
 *
 * A tabela abaixo não é redundância: é como quem usa leitor de tela — ou quem
 * quer o número exato — lê o mesmo dado.
 */
function RevenueChart({ report }: { report: RevenueReport }) {
  if (report.series.length === 0) {
    return (
      <div className="ui-card">
        <p className="dash__empty">Nenhuma venda concluída no período.</p>
      </div>
    );
  }

  const max = Math.max(...report.series.map((point) => point.revenueCents));

  return (
    <div className="ui-card chart">
      <div className="chart__head">
        <h3>Evolução {BUCKET_LABEL[report.bucket]}</h3>
        <span className="chart__max">pico: {formatBRL(max)}</span>
      </div>

      <div className="chart__plot" role="img" aria-label={resumoDoGrafico(report)}>
        {report.series.map((point) => (
          <div key={point.date} className="chart__col" title={`${formatarData(point.date)}: ${formatBRL(point.revenueCents)}`}>
            <div
              className="chart__bar"
              // Piso de 2% para um dia de venda baixa continuar visível em vez
              // de virar uma linha invisível ao lado de um pico.
              style={{ height: `${Math.max(2, (point.revenueCents / max) * 100)}%` }}
            />
            <span className="chart__tick">{formatarData(point.date, report.bucket)}</span>
          </div>
        ))}
      </div>

      <details className="chart__table">
        <summary>Ver números</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Período</th>
              <th scope="col">Pedidos</th>
              <th scope="col">Recebido</th>
            </tr>
          </thead>
          <tbody>
            {report.series.map((point) => (
              <tr key={point.date}>
                <td>{formatarData(point.date)}</td>
                <td className="tnum">{point.orderCount}</td>
                <td className="tnum">{formatBRL(point.revenueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function resumoDoGrafico(report: RevenueReport): string {
  const total = report.series.reduce((sum, point) => sum + point.revenueCents, 0);
  return `Faturamento ${BUCKET_LABEL[report.bucket]} em ${report.series.length} períodos, somando ${formatBRL(total)}.`;
}

function formatarData(iso: string, bucket?: RevenueReport['bucket']): string {
  // `new Date('2026-01-05')` é interpretado como UTC e, em fuso negativo, exibe
  // o dia anterior. Montamos a data em horário local a partir das partes.
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year!, month! - 1, day!);
  if (bucket === 'month') {
    return date.toLocaleDateString('pt-BR', { month: 'short' });
  }
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
