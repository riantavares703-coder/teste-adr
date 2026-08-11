import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { OrderDetail } from '@plataforma/client';
import {
  AsyncBoundary,
  BrandHeader,
  Button,
  Card,
  Notice,
  SectionHeader,
  StatCard,
  Touchable,
  semantic,
  spacing,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import { useBranch } from '../branch-context.js';
import type { ScreenProps } from '../navigation.js';

/**
 * PAINEL INICIAL DO OPERADOR — item 7.
 *
 * O briefing pede exatamente este formato:
 *
 *   PEDIDOS
 *   3 NOVOS · 5 EM PREPARAÇÃO · 2 PRONTOS · 1 EM ROTA
 *
 * e que o operador identifique de RELANCE: novos pedidos, atrasados,
 * aguardando pagamento, prontos, entregas, produtos esgotados. Cada um desses
 * seis vira um cartão tocável que leva direto à lista filtrada — o painel é
 * ponto de partida, não um mural que só informa.
 */
export function DashboardScreen({ navigation }: ScreenProps<'Dashboard'>) {
  const theme = useTheme();
  const { gutter, statColumns } = useResponsive();
  const { api, profile, signOut } = useSession();
  const branch = useBranch();

  const [orders, setOrders] = useState<OrderDetail[]>([]);
  const [soldOutCount, setSoldOutCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!branch.branchId) return;
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [list, inventory] = await Promise.all([
          api.listBranchOrders(branch.branchId, [
            'PENDING',
            'CONFIRMED',
            'PREPARING',
            'READY',
            'AWAITING_PICKUP',
            'OUT_FOR_DELIVERY',
          ]),
          api.listInventory(branch.branchId),
        ]);
        setOrders(list);
        setSoldOutCount(inventory.filter((i) => !i.availability.isPurchasable).length);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api, branch.branchId],
  );

  useEffect(() => {
    void load();
    // Sondagem: a fila muda o tempo todo. Em produção o WebSocket (ADR-0011)
    // empurra a mudança na hora; a sondagem cobre o intervalo entre eventos e
    // a reconexão.
    const timer = setInterval(() => void load('refresh'), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const counts = useMemo(() => {
    const now = Date.now();
    // "Atrasado" é heurística de PAINEL, não uma verdade do servidor: pedido
    // ainda ativo, feito há mais de 30 minutos. O prazo real de preparo é
    // configurável por loja (`preparationTimeMinutes`) — este número é para
    // chamar atenção, não para decidir nada sozinho.
    const isLate = (o: OrderDetail) =>
      ['PENDING', 'CONFIRMED', 'PREPARING'].includes(o.order.status) &&
      now - new Date(o.order.placedAt).getTime() > 30 * 60_000;

    return {
      new: orders.filter((o) => o.order.status === 'PENDING').length,
      preparing: orders.filter((o) => o.order.status === 'PREPARING').length,
      ready: orders.filter((o) => ['READY', 'AWAITING_PICKUP'].includes(o.order.status)).length,
      delivery: orders.filter((o) => o.order.status === 'OUT_FOR_DELIVERY').length,
      late: orders.filter(isLate).length,
      unpaid: orders.filter(
        (o) => o.payment && ['PENDING', 'AWAITING_CONFIRMATION'].includes(o.payment.status),
      ).length,
    };
  }, [orders]);

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <BrandHeader
        title={theme.displayName ?? branch.branch?.name ?? 'Painel'}
        subtitle={profile?.fullName}
        right={
          <Touchable onPress={() => void signOut()} accessibilityLabel="Sair">
            <View style={styles.signOut}>
              <Text style={{ color: theme.onPrimary, fontSize: 18 }}>⏻</Text>
            </View>
          </Touchable>
        }
      >
        {branch.canSwitch ? <BranchSwitcher /> : null}
      </BrandHeader>

      <SafeAreaView edges={['bottom']} style={styles.body}>
        <AsyncBoundary
          loading={loading || branch.loading}
          error={error}
          onRetry={() => void load()}
          onSessionExpired={() => void signOut()}
        >
          <ScrollView
            contentContainerStyle={{ padding: gutter, paddingBottom: spacing.xxxl, gap: spacing.md }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void load('refresh')}
                tintColor={theme.primary}
              />
            }
          >
            {counts.late > 0 ? (
              <Notice tone="danger" title={`${counts.late} pedido(s) atrasado(s)`}>
                Acima de 30 minutos sem avançar. Priorize a fila abaixo.
              </Notice>
            ) : null}

            <SectionHeader title="Pedidos" />
            <View style={[styles.grid, { gap: spacing.md }]}>
              <StatCard
                value={counts.new}
                label="NOVOS"
                tone={{ fg: semantic.warning, bg: semantic.warningBg }}
                emphasis={counts.new > 0}
                onPress={() => navigation.navigate('Orders', { filter: 'NEW' })}
              />
              <StatCard
                value={counts.preparing}
                label="EM PREPARAÇÃO"
                tone={{ fg: semantic.info, bg: semantic.infoBg }}
                onPress={() => navigation.navigate('Orders', { filter: 'PREPARING' })}
              />
              <StatCard
                value={counts.ready}
                label="PRONTOS"
                tone={{ fg: semantic.success, bg: semantic.successBg }}
                onPress={() => navigation.navigate('Orders', { filter: 'READY' })}
              />
              <StatCard
                value={counts.delivery}
                label="EM ROTA"
                tone={{ fg: semantic.info, bg: semantic.infoBg }}
                onPress={() => navigation.navigate('Orders', { filter: 'DELIVERY' })}
              />
            </View>

            <View style={{ height: statColumns >= 4 ? spacing.sm : 0 }} />

            <View style={[styles.grid, { gap: spacing.md }]}>
              <StatCard
                value={counts.late}
                label="ATRASADOS"
                tone={
                  counts.late > 0
                    ? { fg: semantic.danger, bg: semantic.dangerBg }
                    : { fg: semantic.neutral, bg: semantic.neutralBg }
                }
                emphasis={counts.late > 0}
                onPress={() => navigation.navigate('Orders', { filter: 'LATE' })}
              />
              <StatCard
                value={counts.unpaid}
                label="AGUARDANDO PAGAMENTO"
                tone={
                  counts.unpaid > 0
                    ? { fg: semantic.warning, bg: semantic.warningBg }
                    : { fg: semantic.neutral, bg: semantic.neutralBg }
                }
                onPress={() => navigation.navigate('Orders', { filter: 'UNPAID' })}
              />
              <StatCard
                value={soldOutCount}
                label="PRODUTOS ESGOTADOS"
                tone={
                  soldOutCount > 0
                    ? { fg: semantic.danger, bg: semantic.dangerBg }
                    : { fg: semantic.neutral, bg: semantic.neutralBg }
                }
                onPress={() => navigation.navigate('Inventory')}
              />
            </View>

            <Card>
              <View style={styles.quickRow}>
                <View style={styles.flex}>
                  <Button label="Fila de pedidos" variant="secondary" onPress={() => navigation.navigate('Orders')} />
                </View>
                <View style={styles.flex}>
                  <Button label="Estoque" variant="secondary" onPress={() => navigation.navigate('Inventory')} />
                </View>
              </View>
              {profile?.permissions.includes('report:read') ? (
                <View style={{ paddingTop: spacing.sm }}>
                  <Button
                    label="Indicadores da franquia"
                    variant="ghost"
                    onPress={() => navigation.navigate('Franchise')}
                  />
                </View>
              ) : null}
              {profile?.permissions.includes('settings:read') ? (
                <View style={{ paddingTop: spacing.sm }}>
                  <Button
                    label="Configurações"
                    variant="ghost"
                    onPress={() => navigation.navigate('Settings')}
                  />
                </View>
              ) : null}
            </Card>
          </ScrollView>
        </AsyncBoundary>
      </SafeAreaView>
    </View>
  );
}

function BranchSwitcher() {
  const theme = useTheme();
  const branch = useBranch();
  return (
    <ScrollHint>
      {branch.branches.map((b) => {
        const selected = b.id === branch.branchId;
        return (
          <Touchable key={b.id} onPress={() => branch.select(b.id)} accessibilityLabel={b.name}>
            <View
              style={[
                styles.branchChip,
                { backgroundColor: selected ? '#ffffff33' : '#ffffff14' },
              ]}
            >
              <Text style={[styles.branchChipText, { color: theme.onPrimary }]}>{b.name}</Text>
            </View>
          </Touchable>
        );
      })}
    </ScrollHint>
  );
}

function ScrollHint({ children }: { children: React.ReactNode }) {
  return <View style={styles.branchRow}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  quickRow: { flexDirection: 'row', gap: spacing.md },
  signOut: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ffffff26',
    alignItems: 'center',
    justifyContent: 'center',
  },
  branchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.md },
  branchChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 999 },
  branchChipText: { fontSize: 12, fontWeight: '700' },
});
