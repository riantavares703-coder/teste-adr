import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { OrderDetail } from '@plataforma/client';
import type { OrderStatus } from '@plataforma/domain';
import { nextStatuses } from '@plataforma/domain';
import {
  AsyncBoundary,
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  Price,
  friendlyMessage,
  spacing,
  toneForOrder,
  toneForPayment,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import { useBranch } from '../branch-context.js';
import type { ScreenProps } from '../navigation.js';

const ACTIVE_STATUSES: OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'READY',
  'AWAITING_PICKUP',
  'OUT_FOR_DELIVERY',
];

const FILTER_LABEL: Record<string, string> = {
  NEW: 'Novos',
  PREPARING: 'Em preparação',
  READY: 'Prontos',
  DELIVERY: 'Em rota',
  LATE: 'Atrasados',
  UNPAID: 'Aguardando pagamento',
};

/**
 * FILA DE PEDIDOS.
 *
 * Cada card mostra as duas máquinas de estado lado a lado — pedido e
 * pagamento — porque são independentes (Prompt 02, item 7): um pedido pode
 * estar "Em preparo" com pagamento "Pendente" (cobrança na entrega), e o
 * operador precisa ver os dois estados sem abrir o pedido.
 *
 * O botão de avançar mostra só as transições que ESTE papel, NESTE estado,
 * pode fazer — `nextStatuses` é a mesma função pura que o servidor usa para
 * decidir. Errar aqui só custa um clique a mais; quem barra de verdade é o
 * servidor, que reavalia tudo na hora da transição.
 */
export function OrdersScreen({ route }: ScreenProps<'Orders'>) {
  const theme = useTheme();
  const { gutter } = useResponsive();
  const { api, signOut } = useSession();
  const branch = useBranch();

  const [orders, setOrders] = useState<OrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<string | undefined>(route.params?.filter);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!branch.branchId) return;
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        setOrders(await api.listBranchOrders(branch.branchId, ACTIVE_STATUSES));
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
    const timer = setInterval(() => void load('refresh'), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const now = Date.now();
    switch (filter) {
      case 'NEW':
        return orders.filter((o) => o.order.status === 'PENDING');
      case 'PREPARING':
        return orders.filter((o) => o.order.status === 'PREPARING');
      case 'READY':
        return orders.filter((o) => ['READY', 'AWAITING_PICKUP'].includes(o.order.status));
      case 'DELIVERY':
        return orders.filter((o) => o.order.status === 'OUT_FOR_DELIVERY');
      case 'LATE':
        return orders.filter(
          (o) =>
            ['PENDING', 'CONFIRMED', 'PREPARING'].includes(o.order.status) &&
            now - new Date(o.order.placedAt).getTime() > 30 * 60_000,
        );
      case 'UNPAID':
        return orders.filter(
          (o) => o.payment && ['PENDING', 'AWAITING_CONFIRMATION'].includes(o.payment.status),
        );
      default:
        return orders;
    }
  }, [orders, filter]);

  async function advance(order: OrderDetail, to: OrderStatus) {
    if (!branch.branchId) return;
    setBusyOrderId(order.order.id);
    setActionError(null);
    try {
      await api.transitionOrder(branch.branchId, order.order.id, to);
      await load('refresh');
    } catch (e) {
      // O servidor recusa transições inválidas mesmo que o botão apareça
      // (ex.: pagamento Pix ainda não confirmado). O erro chega aqui em vez
      // de o app fingir que avançou.
      setActionError(friendlyMessage(e));
    } finally {
      setBusyOrderId(null);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <AsyncBoundary
        loading={loading || branch.loading}
        error={error}
        onRetry={() => void load()}
        onSessionExpired={() => void signOut()}
      >
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.order.id}
          contentContainerStyle={{ padding: gutter, gap: spacing.md, paddingBottom: spacing.xxxl }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={theme.primary} />
          }
          ListHeaderComponent={
            <View style={styles.filters}>
              <Chip label="Todos" selected={!filter} onPress={() => setFilter(undefined)} />
              {Object.entries(FILTER_LABEL).map(([key, label]) => (
                <Chip key={key} label={label} selected={filter === key} onPress={() => setFilter(key)} />
              ))}
            </View>
          }
          ListEmptyComponent={
            <EmptyState
              icon="✅"
              title="Nenhum pedido aqui"
              description={filter ? 'Nada nesta categoria no momento.' : 'A fila está em dia.'}
            />
          }
          renderItem={({ item }) => (
            <OrderCard
              order={item}
              busy={busyOrderId === item.order.id}
              onAdvance={(to) => void advance(item, to)}
            />
          )}
        />
        {actionError ? (
          <View style={{ paddingHorizontal: gutter }}>
            <Text style={{ color: theme.text }}>{actionError}</Text>
          </View>
        ) : null}
      </AsyncBoundary>
    </View>
  );
}

function OrderCard({
  order,
  busy,
  onAdvance,
}: {
  order: OrderDetail;
  busy: boolean;
  onAdvance: (to: OrderStatus) => void;
}) {
  const theme = useTheme();
  const options = nextStatuses(order.order.status, order.order.fulfillment, 'STAFF');
  const primaryNext = options[0];
  const minutesAgo = Math.max(0, Math.round((Date.now() - new Date(order.order.placedAt).getTime()) / 60_000));

  return (
    <Card>
      <View style={styles.cardHeader}>
        <View>
          <Text style={theme.font('subheading')}>#{order.order.orderNumber}</Text>
          <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
            {order.order.fulfillment === 'DELIVERY' ? '🛵 Entrega' : '🏪 Retirada'} · há {minutesAgo} min
          </Text>
        </View>
        <Price cents={order.order.totalCents} />
      </View>

      <View style={styles.badges}>
        <Badge tone={toneForOrder(order.order.status)} />
        {order.payment ? <Badge tone={toneForPayment(order.payment.status)} /> : null}
      </View>

      <View style={styles.items}>
        {order.items.slice(0, 3).map((item) => (
          <Text key={item.id} numberOfLines={1} style={[theme.font('caption'), { color: theme.mutedText }]}>
            {item.quantity}× {item.productNameSnapshot}
          </Text>
        ))}
        {order.items.length > 3 ? (
          <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
            + {order.items.length - 3} item(ns)
          </Text>
        ) : null}
      </View>

      {order.order.customerNotes ? (
        <Text style={[theme.font('caption'), { color: theme.text, fontStyle: 'italic' }]}>
          &ldquo;{order.order.customerNotes}&rdquo;
        </Text>
      ) : null}

      {primaryNext ? (
        <Button
          label={ACTION_LABEL[primaryNext] ?? `Marcar como ${toneForOrder(primaryNext).label}`}
          loading={busy}
          onPress={() => onAdvance(primaryNext)}
        />
      ) : null}
    </Card>
  );
}

const ACTION_LABEL: Partial<Record<OrderStatus, string>> = {
  CONFIRMED: 'Confirmar pedido',
  PREPARING: 'Iniciar preparo',
  READY: 'Marcar como pronto',
  AWAITING_PICKUP: 'Disponível para retirada',
  OUT_FOR_DELIVERY: 'Saiu para entrega',
  DELIVERED: 'Marcar como entregue',
  PICKED_UP: 'Marcar como retirado',
};

const styles = StyleSheet.create({
  screen: { flex: 1 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingBottom: spacing.sm },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  badges: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm, flexWrap: 'wrap' },
  items: { gap: 2, paddingBottom: spacing.sm },
});
