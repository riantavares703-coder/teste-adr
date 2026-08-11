import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { io, type Socket } from 'socket.io-client';
import type { Menu, OrderDetail } from '@plataforma/client';
import {
  ORDER_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  isTerminalOrderStatus,
  type OrderStatus,
} from '@plataforma/domain';
import {
  Badge,
  Button,
  ErrorState,
  Loading,
  Price,
  Row,
  palette,
  paymentStatusColors,
  radius,
  spacing,
  statusColors,
  themeFromBranding,
  typography,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import type { ScreenProps } from '../navigation.js';

/** Etapas exibidas ao cliente, por modalidade. */
const PICKUP_STEPS: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'AWAITING_PICKUP', 'PICKED_UP'];
const DELIVERY_STEPS: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'];

/**
 * Acompanhamento do pedido (itens 8 e 11).
 *
 * WebSocket para atualização ao vivo; polling como degradação quando a conexão
 * cai. O evento é apenas GATILHO — ao receber, buscamos o estado real por REST,
 * então evento perdido ou fora de ordem não corrompe a tela.
 */
export function TrackingScreen({ route }: ScreenProps<'Tracking'>) {
  const { orderId, menu } = route.params;
  const { api } = useSession();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.getOrder(orderId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let socket: Socket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      const token = (api as unknown as { accessToken: string | null }).accessToken;
      // Token no HANDSHAKE, nunca na query string (vaza em log de proxy).
      socket = io(api.baseUrl, { transports: ['websocket'], auth: { token } });

      socket.on('connect', () => {
        setLive(true);
        socket?.emit('join:order', { orderId });
      });
      socket.on('disconnect', () => setLive(false));
      socket.on('order.status_changed', () => void load());
      socket.on('payment.confirmed', () => void load());
    })();

    // Rede de segurança: se o WebSocket não conectar, o polling mantém a tela viva.
    poll = setInterval(() => void load(), 15_000);

    return () => {
      socket?.disconnect();
      if (poll) clearInterval(poll);
    };
  }, [api, orderId, load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!detail) return <Loading label="Buscando seu pedido…" />;

  const theme = themeFromBranding(menu.branding);
  const steps = detail.order.fulfillment === 'PICKUP' ? PICKUP_STEPS : DELIVERY_STEPS;
  const currentIndex = steps.indexOf(detail.order.status);
  const cancelled = ['CANCELLED', 'REJECTED', 'EXPIRED'].includes(detail.order.status);
  const orderColors = statusColors[detail.order.status] ?? statusColors.PENDING!;
  const paymentColors = detail.payment
    ? (paymentStatusColors[detail.payment.status] ?? paymentStatusColors.PENDING!)
    : null;

  const canCancel = detail.order.status === 'PENDING';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={typography.caption}>PEDIDO</Text>
        <Text style={styles.orderNumber}>#{detail.order.orderNumber}</Text>
        <Badge label={ORDER_STATUS_LABEL[detail.order.status]} fg={orderColors.fg} bg={orderColors.bg} />
        {live ? <Text style={styles.live}>● ao vivo</Text> : null}
      </View>

      {/* As duas máquinas de estado, lado a lado e sem se misturar. */}
      <View style={styles.card}>
        <Row label="Valor" value={formatBRL(detail.order.totalCents)} strong />
        <Row label="Pagamento" value={PAYMENT_METHOD_LABEL[detail.order.paymentMethod]} />
        <Row
          label="Recebimento"
          value={detail.order.fulfillment === 'PICKUP' ? 'Retirada' : 'Entrega'}
        />
        {detail.payment && paymentColors ? (
          <View style={styles.paymentRow}>
            <Text style={typography.body}>Status do pagamento</Text>
            <Badge
              label={PAYMENT_STATUS_LABEL[detail.payment.status]}
              fg={paymentColors.fg}
              bg={paymentColors.bg}
            />
          </View>
        ) : null}
      </View>

      {cancelled ? (
        <View style={[styles.card, { backgroundColor: palette.dangerBg }]}>
          <Text style={[typography.heading, { color: palette.danger }]}>
            {ORDER_STATUS_LABEL[detail.order.status]}
          </Text>
          {detail.history.at(-1)?.reason ? (
            <Text style={typography.caption}>Motivo: {detail.history.at(-1)!.reason}</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={typography.heading}>Andamento</Text>
          {steps.map((step, index) => {
            const done = index <= currentIndex;
            const current = index === currentIndex;
            return (
              <View key={step} style={styles.step}>
                <View
                  style={[
                    styles.stepDot,
                    done && { backgroundColor: theme.primary, borderColor: theme.primary },
                    current && styles.stepDotCurrent,
                  ]}
                />
                <Text
                  style={[
                    typography.body,
                    done && { color: palette.ink900, fontWeight: current ? '700' : '500' },
                    !done && { color: palette.ink500 },
                  ]}
                >
                  {ORDER_STATUS_LABEL[step]}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.card}>
        <Text style={typography.heading}>Itens</Text>
        {detail.items.map((item) => (
          <View key={item.id} style={styles.item}>
            <Text style={typography.body}>
              {item.quantity}× {item.productNameSnapshot}
            </Text>
            <Price cents={item.lineTotalCents} size="sm" />
          </View>
        ))}
        <View style={styles.divider} />
        <Row label="Subtotal" value={formatBRL(detail.order.subtotalCents)} />
        {detail.order.deliveryFeeCents > 0 ? (
          <Row label="Taxa de entrega" value={formatBRL(detail.order.deliveryFeeCents)} />
        ) : null}
        <Row label="Total" value={formatBRL(detail.order.totalCents)} strong />
      </View>

      {canCancel ? (
        <Button
          label="Cancelar pedido"
          variant="danger"
          onPress={() => {
            void api.cancelOrder(orderId).then(load).catch((e: Error) => setError(e.message));
          }}
        />
      ) : null}

      {isTerminalOrderStatus(detail.order.status) ? null : (
        <Text style={[typography.caption, styles.footNote]}>
          Você receberá uma notificação a cada mudança de status.
        </Text>
      )}
    </ScrollView>
  );
}

function formatBRL(cents: number): string {
  return `R$ ${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.ink100 },
  content: { padding: spacing.lg, gap: spacing.md },
  header: { alignItems: 'center', gap: spacing.xs },
  orderNumber: { fontSize: 32, fontWeight: '800', color: palette.ink900 },
  live: { fontSize: 11, color: palette.success, fontWeight: '700' },
  card: { backgroundColor: palette.white, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  step: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  stepDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: palette.ink300,
    backgroundColor: palette.white,
  },
  stepDotCurrent: { transform: [{ scale: 1.25 }] },
  item: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.xs },
  divider: { height: 1, backgroundColor: palette.ink100, marginVertical: spacing.sm },
  footNote: { textAlign: 'center', marginTop: spacing.md },
});
