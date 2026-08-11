import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { OrderDetail } from '@plataforma/client';
import {
  AsyncBoundary,
  Badge,
  Button,
  Card,
  Notice,
  Price,
  ProductRow,
  Row,
  SectionHeader,
  StickyBar,
  ThemeProvider,
  Timeline,
  adoptTheme,
  friendlyMessage,
  spacing,
  toneForOrder,
  toneForPayment,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import type { ScreenProps } from '../navigation.js';
import { formatBRL } from '@plataforma/domain';

/**
 * ACOMPANHAMENTO.
 *
 * A pergunta que esta tela responde é "onde está meu pedido agora". A linha do
 * tempo mostra o caminho inteiro com o passo atual destacado — muito mais
 * legível que uma lista de eventos, que obriga o cliente a interpretar.
 *
 * Os passos DEPENDEM da forma de recebimento: quem vai retirar nunca passa por
 * "saiu para entrega", e mostrar esse passo esmaecido só geraria dúvida.
 */
const DELIVERY_STEPS = [
  { status: 'PENDING', label: 'Recebido' },
  { status: 'CONFIRMED', label: 'Confirmado' },
  { status: 'PREPARING', label: 'Em preparo' },
  { status: 'OUT_FOR_DELIVERY', label: 'Saiu para entrega' },
  { status: 'DELIVERED', label: 'Entregue' },
];

const PICKUP_STEPS = [
  { status: 'PENDING', label: 'Recebido' },
  { status: 'CONFIRMED', label: 'Confirmado' },
  { status: 'PREPARING', label: 'Em preparo' },
  { status: 'READY', label: 'Pronto' },
  { status: 'PICKED_UP', label: 'Retirado' },
];

const FINISHED = ['DELIVERED', 'PICKED_UP', 'CANCELLED', 'REJECTED', 'EXPIRED'];

export function TrackingScreen({ route, navigation }: ScreenProps<'Tracking'>) {
  const { orderId, menu } = route.params;
  const theme = useMemo(() => adoptTheme(menu.theme, menu.theme), [menu.theme]);
  return (
    <ThemeProvider value={theme}>
      <TrackingContent orderId={orderId} navigation={navigation} />
    </ThemeProvider>
  );
}

function TrackingContent({
  orderId,
  navigation,
}: {
  orderId: string;
  navigation: ScreenProps<'Tracking'>['navigation'];
}) {
  const theme = useTheme();
  const { gutter } = useResponsive();
  const { api } = useSession();

  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.getOrder(orderId));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const order = detail?.order ?? null;
  const finished = order ? FINISHED.includes(order.status) : false;

  useEffect(() => {
    // A sondagem PARA quando o pedido termina. Continuar consultando um pedido
    // entregue gasta bateria e dados do cliente sem trazer nada novo.
    if (finished) return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [finished, load]);

  const steps = order?.fulfillment === 'PICKUP' ? PICKUP_STEPS : DELIVERY_STEPS;
  const currentIndex = order ? indexOfStatus(steps, order.status, detail?.history ?? []) : 0;
  const cancelled = order ? ['CANCELLED', 'REJECTED', 'EXPIRED'].includes(order.status) : false;

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelOrder(orderId);
      await load();
    } catch (e) {
      // O servidor decide se dá para cancelar. Fora da janela, ele recusa — e
      // o app mostra o motivo em vez de fingir que cancelou.
      setCancelError(friendlyMessage(e));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={() => void load()}
        onSessionExpired={() => navigation.navigate('Login')}
      >
        {order && detail ? (
          <>
            <ScrollView
              contentContainerStyle={{ padding: gutter, paddingBottom: spacing.xxxl }}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    setRefreshing(true);
                    void load();
                  }}
                  tintColor={theme.primary}
                />
              }
            >
              <Card>
                <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
                  Pedido #{order.orderNumber}
                </Text>
                <Text style={theme.font('title')}>
                  {cancelled ? 'Pedido encerrado' : toneForOrder(order.status).label}
                </Text>
                <View style={styles.badges}>
                  <Badge tone={toneForOrder(order.status)} />
                  {detail.payment ? <Badge tone={toneForPayment(detail.payment.status)} /> : null}
                </View>

                {!cancelled ? (
                  <View style={{ paddingTop: spacing.lg }}>
                    <Timeline
                      steps={steps.map((s) => ({ label: s.label }))}
                      currentIndex={currentIndex}
                    />
                  </View>
                ) : null}
              </Card>

              {cancelled ? (
                <Notice tone="danger" title={toneForOrder(order.status).label}>
                  Este pedido não será preparado. Em caso de dúvida, fale com a loja.
                </Notice>
              ) : null}

              {detail.payment && detail.payment.status !== 'CONFIRMED' && detail.payment.method === 'PIX' ? (
                <Notice tone="warning" title="Pagamento pendente">
                  Assim que a loja confirmar o recebimento do Pix, o pedido avança.
                </Notice>
              ) : null}

              <SectionHeader title="Itens" count={detail.items.length} />
              <Card padded={false} style={{ paddingHorizontal: gutter }}>
                {detail.items.map((item) => (
                  <ProductRow
                    key={item.id}
                    title={`${item.quantity}× ${item.productNameSnapshot}`}
                    subtitle={item.notes ? `Obs.: ${item.notes}` : null}
                    right={<Price cents={item.lineTotalCents} size="sm" />}
                  />
                ))}
              </Card>

              <Card>
                <Row label="Subtotal" value={formatBRL(order.subtotalCents)} />
                {order.deliveryFeeCents > 0 ? (
                  <Row label="Entrega" value={formatBRL(order.deliveryFeeCents)} />
                ) : null}
                <Row label="Total" value={formatBRL(order.totalCents)} strong />
              </Card>

              {detail.history.length > 0 ? (
                <>
                  <SectionHeader title="Histórico" />
                  <Card>
                    {detail.history.map((entry, index) => (
                      <Row
                        key={`${entry.toStatus}-${index}`}
                        label={toneForOrder(entry.toStatus).label}
                        value={formatDateTime(entry.createdAt)}
                      />
                    ))}
                  </Card>
                </>
              ) : null}

              {cancelError ? <Notice tone="danger">{cancelError}</Notice> : null}
            </ScrollView>

            <SafeAreaView edges={['bottom']}>
              <StickyBar>
                {order.status === 'PENDING' ? (
                  <Button
                    label="Cancelar pedido"
                    variant="ghost"
                    loading={cancelling}
                    onPress={() => void cancel()}
                    accessibilityHint="Cancela enquanto a loja ainda não confirmou"
                  />
                ) : null}
                <Button
                  label="Voltar ao cardápio"
                  variant={order.status === 'PENDING' ? 'secondary' : 'primary'}
                  onPress={() => navigation.popToTop()}
                />
              </StickyBar>
            </SafeAreaView>
          </>
        ) : null}
      </AsyncBoundary>
    </View>
  );
}

/**
 * Posição na linha do tempo.
 *
 * Não basta procurar o status ATUAL na lista: um pedido `READY` numa entrega
 * não aparece em `DELIVERY_STEPS`. Por isso caminhamos pelo histórico e
 * ficamos no passo mais avançado que realmente aconteceu.
 */
function indexOfStatus(
  steps: Array<{ status: string }>,
  current: string,
  history: Array<{ toStatus: string }>,
): number {
  const direct = steps.findIndex((s) => s.status === current);
  if (direct >= 0) return direct;

  let best = 0;
  for (const entry of history) {
    const index = steps.findIndex((s) => s.status === entry.toStatus);
    if (index > best) best = index;
  }
  return best;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  badges: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm, flexWrap: 'wrap' },
});
