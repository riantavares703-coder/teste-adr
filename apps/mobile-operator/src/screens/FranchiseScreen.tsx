import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AnalyticsSummary } from '@plataforma/client';
import {
  AsyncBoundary,
  Card,
  Chip,
  EmptyState,
  Row,
  SectionHeader,
  StatCard,
  spacing,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import { formatBRL } from '@plataforma/domain';

const PERIODS = [
  { label: '7 dias', days: 7 },
  { label: '30 dias', days: 30 },
  { label: '90 dias', days: 90 },
];

/**
 * INDICADORES CONSOLIDADOS — item 8.
 *
 * Só aparece no menu para quem tem `report:read` (a franquia inteira e o
 * operador comum, cada um vendo o que o servidor decidir mostrar). O
 * `AnalyticsService.resolveScope` do backend é quem decide se a resposta é
 * "toda a organização" ou "só a unidade dele" — esta tela não filtra nada
 * localmente, só exibe o que chegou.
 */
export function FranchiseScreen() {
  const theme = useTheme();
  const { gutter, isTablet } = useResponsive();
  const { api, signOut } = useSession();

  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await api.getAnalytics({ days }));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={() => void load()}
        onSessionExpired={() => void signOut()}
      >
        <ScrollView contentContainerStyle={{ padding: gutter, gap: spacing.md, paddingBottom: spacing.xxxl }}>
          <View style={styles.chips}>
            {PERIODS.map((p) => (
              <Chip key={p.days} label={p.label} selected={days === p.days} onPress={() => setDays(p.days)} />
            ))}
          </View>

          {summary ? (
            <>
              <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
                {summary.scope === 'ORGANIZATION'
                  ? `${summary.branchCount} unidade(s) da franquia`
                  : 'Sua unidade'}
              </Text>

              <View style={[styles.grid, isTablet && styles.gridTablet]}>
                <StatCard value={summary.totals.orderCount} label="TOTAL DE PEDIDOS" />
                <StatCard value={formatBRL(summary.totals.revenueCents)} label="FATURAMENTO" />
                <StatCard value={formatBRL(summary.totals.averageTicketCents)} label="TICKET MÉDIO" />
                <StatCard value={summary.totals.cancelledCount} label="CANCELADOS" />
              </View>

              <SectionHeader title="Produtos mais vendidos" />
              {summary.topProducts.length === 0 ? (
                <EmptyState icon="📊" title="Sem vendas no período" />
              ) : (
                <Card padded={false} style={{ padding: gutter }}>
                  {summary.topProducts.map((p, index) => (
                    <Row
                      key={p.productId}
                      label={`${index + 1}. ${p.productName} · ${p.quantity} un.`}
                      value={formatBRL(p.revenueCents)}
                    />
                  ))}
                </Card>
              )}

              {summary.scope === 'ORGANIZATION' ? (
                <>
                  <SectionHeader title="Pedidos por unidade" />
                  <Card padded={false} style={{ padding: gutter }}>
                    {summary.byBranch.map((b) => (
                      <Row
                        key={b.branchId}
                        label={`${b.branchName} · ${b.orderCount} pedido(s)`}
                        value={formatBRL(b.revenueCents)}
                      />
                    ))}
                  </Card>
                </>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </AsyncBoundary>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  chips: { flexDirection: 'row', gap: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  gridTablet: { flexWrap: 'nowrap' },
});
