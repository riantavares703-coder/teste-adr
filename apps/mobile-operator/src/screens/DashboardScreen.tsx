import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { io, type Socket } from 'socket.io-client';
import type { OrderDetail } from '@plataforma/client';
import {
  ORDER_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  nextStatuses,
  type OrderStatus,
} from '@plataforma/domain';
import {
  Badge,
  Button,
  ErrorState,
  Loading,
  Price,
  palette,
  paymentStatusColors,
  radius,
  spacing,
  statusColors,
  typography,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import type { ScreenProps } from '../navigation.js';

/** Colunas do painel operacional (item 9 do Prompt 02). */
const COLUMNS: Array<{ key: string; title: string; statuses: OrderStatus[] }> = [
  { key: 'new', title: 'PEDIDOS NOVOS', statuses: ['PENDING'] },
  { key: 'preparing', title: 'EM PREPARAÇÃO', statuses: ['CONFIRMED', 'PREPARING'] },
  { key: 'ready', title: 'PRONTOS', statuses: ['READY', 'AWAITING_PICKUP'] },
  { key: 'route', title: 'EM ROTA', statuses: ['OUT_FOR_DELIVERY'] },
  { key: 'done', title: 'ENTREGUES', statuses: ['DELIVERED', 'PICKED_UP'] },
  { key: 'cancelled', title: 'CANCELADOS', statuses: ['CANCELLED', 'REJECTED', 'EXPIRED'] },
];

/**
 * Painel do operador.
 *
 * Atualiza sozinho (item 11): WebSocket na sala da unidade, com polling como
 * degradação. O operador nunca precisa puxar a tela para ver pedido novo.
 */
export function DashboardScreen({ navigation }: ScreenProps<'Dashboard'>) {
  const { api, profile } = useSession();
  const branchId = profile?.branchScope[0] ?? null;

  const [orders, setOrders] = useState<OrderDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(false);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      setError(null);
      setOrders(await api.listBranchOrders(branchId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!branchId) return;
    const token = (api as unknown as { accessToken: string | null }).accessToken;
    const socket: Socket = io(api.baseUrl, {
      transports: ['websocket'],
      auth: { token }, // handshake, nunca query string
    });

    socket.on('connect', () => {
      setLive(true);
      socket.emit('join:branch', { branchId });
    });
    socket.on('disconnect', () => setLive(false));
    // Eventos são gatilho: recarregamos o estado real por REST.
    for (const event of ['order.created', 'order.status_changed', 'payment.confirmed']) {
      socket.on(event, () => void load());
    }

    const poll = setInterval(() => void load(), 20_000);
    return () => {
      socket.disconnect();
      clearInterval(poll);
    };
  }, [api, branchId, load]);

  const grouped = useMemo(() => {
    const map = new Map<string, OrderDetail[]>();
    for (const column of COLUMNS) {
      map.set(
        column.key,
        (orders ?? []).filter((o) => column.statuses.includes(o.order.status)),
      );
    }
    return map;
  }, [orders]);

  async function advance(detail: OrderDetail, to: OrderStatus) {
    if (!branchId) return;
    setBusyOrderId(detail.order.id);
    try {
      await api.transitionOrder(branchId, detail.order.id, to);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyOrderId(null);
    }
  }

  async function confirmPayment(detail: OrderDetail) {
    if (!branchId || !detail.payment) return;
    setBusyOrderId(detail.order.id);
    try {
      await api.confirmPayment(branchId, detail.payment.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyOrderId(null);
    }
  }

  if (!branchId) {
    return <ErrorState message="Seu usuário não tem unidade associada." />;
  }
  if (error && !orders) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!orders) return <Loading label="Carregando pedidos…" />;

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <Text style={typography.heading}>Pedidos</Text>
        <View style={styles.topBarRight}>
          <Text style={[styles.liveDot, { color: live ? palette.success : palette.ink500 }]}>
            {live ? '● tempo real' : '○ reconectando'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Abrir estoque"
            onPress={() => navigation.navigate('Inventory')}
          >
            <Text style={styles.link}>Estoque</Text>
          </Pressable>
        </View>
      </View>

      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {COLUMNS.map((column) => {
          const items = grouped.get(column.key) ?? [];
          if (items.length === 0 && ['done', 'cancelled'].includes(column.key)) return null;

          return (
            <View key={column.key} style={styles.column}>
              <View style={styles.columnHeader}>
                <Text style={styles.columnTitle}>{column.title}</Text>
                <View style={styles.counter}>
                  <Text style={styles.counterText}>{items.length}</Text>
                </View>
              </View>

              {items.length === 0 ? (
                <Text style={styles.columnEmpty}>Nenhum pedido</Text>
              ) : (
                items.map((detail) => (
                  <OrderCard
                    key={detail.order.id}
                    detail={detail}
                    busy={busyOrderId === detail.order.id}
                    onAdvance={(to) => void advance(detail, to)}
                    onConfirmPayment={() => void confirmPayment(detail)}
                  />
                ))
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * Card do pedido — o formato pedido no briefing:
 *   PEDIDO #1042 / R$ 58,90 / PIX / RETIRADA / 2x X-Burger / [ ACEITAR ]
 */
function OrderCard({
  detail,
  busy,
  onAdvance,
  onConfirmPayment,
}: {
  detail: OrderDetail;
  busy: boolean;
  onAdvance: (to: OrderStatus) => void;
  onConfirmPayment: () => void;
}) {
  const { order, items, payment } = detail;
  const colors = statusColors[order.status] ?? statusColors.PENDING!;
  const paymentColors = payment
    ? (paymentStatusColors[payment.status] ?? paymentStatusColors.PENDING!)
    : null;

  const options = nextStatuses(order.status, order.fulfillment);
  const needsPayment =
    order.paymentMethod === 'PIX' && payment !== null && payment.status !== 'CONFIRMED';

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardNumber}>PEDIDO #{order.orderNumber}</Text>
        <Badge label={ORDER_STATUS_LABEL[order.status]} fg={colors.fg} bg={colors.bg} />
      </View>

      <Price cents={order.totalCents} size="lg" />

      <View style={styles.cardMeta}>
        <Text style={styles.metaTag}>{PAYMENT_METHOD_LABEL[order.paymentMethod]}</Text>
        <Text style={styles.metaTag}>
          {order.fulfillment === 'PICKUP' ? 'RETIRADA' : 'ENTREGA'}
        </Text>
        {paymentColors ? (
          <Badge
            label={`Pgto: ${PAYMENT_STATUS_LABEL[payment!.status]}`}
            fg={paymentColors.fg}
            bg={paymentColors.bg}
          />
        ) : null}
      </View>

      <View style={styles.cardItems}>
        {items.map((item) => (
          <Text key={item.id} style={typography.body}>
            {item.quantity}× {item.productNameSnapshot}
            {item.notes ? ` — ${item.notes}` : ''}
          </Text>
        ))}
      </View>

      {order.customerNotes ? (
        <Text style={styles.customerNotes}>Obs.: {order.customerNotes}</Text>
      ) : null}

      {/* Pix pendente: confirmar o RECEBIMENTO é uma ação separada de aceitar
          o pedido. As duas máquinas de estado não se misturam. */}
      {needsPayment ? (
        <Button
          label={busy ? 'Confirmando…' : 'Confirmar recebimento do Pix'}
          variant="secondary"
          loading={busy}
          onPress={onConfirmPayment}
          style={styles.action}
        />
      ) : null}

      {options.map((to) => (
        <Button
          key={to}
          label={actionLabel(order.status, to)}
          loading={busy}
          onPress={() => onAdvance(to)}
          variant={to === 'CANCELLED' || to === 'REJECTED' ? 'ghost' : 'primary'}
          style={styles.action}
        />
      ))}
    </View>
  );
}

function actionLabel(from: OrderStatus, to: OrderStatus): string {
  if (from === 'PENDING' && to === 'CONFIRMED') return 'ACEITAR';
  if (to === 'PREPARING') return 'INICIAR PREPARO';
  if (to === 'READY') return 'MARCAR PRONTO';
  if (to === 'AWAITING_PICKUP') return 'LIBERAR PARA RETIRADA';
  if (to === 'OUT_FOR_DELIVERY') return 'SAIU PARA ENTREGA';
  if (to === 'DELIVERED') return 'ENTREGUE';
  if (to === 'PICKED_UP') return 'RETIRADO';
  if (to === 'CANCELLED') return 'Cancelar';
  if (to === 'REJECTED') return 'Recusar';
  return ORDER_STATUS_LABEL[to];
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.ink100 },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
    backgroundColor: palette.white,
    borderBottomWidth: 1,
    borderBottomColor: palette.ink100,
  },
  topBarRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  liveDot: { fontSize: 11, fontWeight: '700' },
  link: { color: palette.brand, fontWeight: '700' },
  errorBanner: {
    backgroundColor: palette.dangerBg,
    color: palette.danger,
    padding: spacing.md,
    fontSize: 13,
  },
  content: { padding: spacing.lg, gap: spacing.xl },
  column: { gap: spacing.sm },
  columnHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  columnTitle: { fontSize: 13, fontWeight: '800', color: palette.ink500, letterSpacing: 0.6 },
  counter: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: palette.ink300,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  counterText: { fontSize: 12, fontWeight: '700', color: palette.ink900 },
  columnEmpty: { ...typography.caption, fontStyle: 'italic' },
  card: {
    backgroundColor: palette.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: palette.ink100,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardNumber: { fontSize: 16, fontWeight: '800', color: palette.ink900 },
  cardMeta: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
  metaTag: {
    fontSize: 11,
    fontWeight: '700',
    color: palette.ink700,
    backgroundColor: palette.ink100,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  cardItems: { gap: 2, marginTop: spacing.xs },
  customerNotes: { ...typography.caption, fontStyle: 'italic' },
  action: { marginTop: spacing.sm },
});
