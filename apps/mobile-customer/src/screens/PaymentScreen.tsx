import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { Menu, OrderDetail, PaymentView } from '@plataforma/client';
import { PAYMENT_STATUS_LABEL } from '@plataforma/domain';
import {
  Badge,
  Button,
  ErrorState,
  Loading,
  Notice,
  Price,
  Row,
  palette,
  paymentStatusColors,
  radius,
  spacing,
  themeFromBranding,
  typography,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import type { ScreenProps } from '../navigation.js';

/**
 * Tela de pagamento Pix (item 7 do Prompt 02).
 *
 * Mostra VALOR, CHAVE PIX e COPIAR CHAVE, como pedido — e vai além: o
 * "Copia e Cola" já vem com o valor embutido, o que elimina o erro de digitação.
 *
 * O ponto mais importante desta tela é o que ela NÃO afirma: copiar a chave não
 * confirma pagamento nenhum. O aviso é explícito e o estado do pagamento
 * continua "aguardando confirmação" até a loja confirmar o recebimento.
 */
export function PaymentScreen({ route, navigation }: ScreenProps<'Payment'>) {
  const { orderId, menu } = route.params;
  const { api } = useSession();

  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'brcode' | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const theme = themeFromBranding(menu.branding);

  const load = useCallback(async () => {
    try {
      const [paymentView, orderDetail] = await Promise.all([
        api.getPayment(orderId),
        api.getOrder(orderId),
      ]);
      setPayment(paymentView);
      setDetail(orderDetail);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, orderId]);

  useEffect(() => {
    void load();
    // Enquanto o pagamento não é confirmado, consultamos periodicamente.
    // (Com WebSocket ativo, o evento chega antes; o polling é a rede de
    // segurança para quando a conexão cai.)
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!detail?.order.reservationExpiresAt) return;
    const target = new Date(detail.order.reservationExpiresAt).getTime();
    const tick = () => setRemaining(Math.max(0, Math.floor((target - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [detail?.order.reservationExpiresAt]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!payment || !detail) return <Loading label="Preparando o pagamento…" />;

  const confirmed = payment.status === 'CONFIRMED';
  const colors = paymentStatusColors[payment.status] ?? paymentStatusColors.PENDING!;

  async function copyBrCode() {
    if (!payment?.pixBrcode) return;
    await Clipboard.setStringAsync(payment.pixBrcode);
    setCopied('brcode');
    setTimeout(() => setCopied(null), 2500);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={typography.caption}>Pedido</Text>
        <Text style={styles.orderNumber}>#{detail.order.orderNumber}</Text>
        <Badge label={PAYMENT_STATUS_LABEL[payment.status]} fg={colors.fg} bg={colors.bg} />
      </View>

      <View style={styles.amountBox}>
        <Text style={typography.caption}>Valor a pagar</Text>
        <Price cents={payment.amountCents} size="lg" />
      </View>

      {confirmed ? (
        <Notice tone="info">
          Pagamento confirmado pela loja. Seu pedido já está na fila de preparo.
        </Notice>
      ) : (
        <>
          {/* O aviso mais importante da tela. */}
          <Notice tone="warning">
            Copiar a chave NÃO confirma o pagamento. Depois de pagar no seu banco, aguarde a
            confirmação da loja — ela aparece aqui automaticamente.
          </Notice>

          {remaining !== null ? (
            <View style={styles.timer}>
              <Text style={typography.caption}>
                {remaining > 0
                  ? `Conclua o pagamento em ${formatDuration(remaining)}`
                  : 'A janela de pagamento expirou. Faça um novo pedido.'}
              </Text>
            </View>
          ) : null}

          {payment.pixBrcode ? (
            <View style={styles.pixBox}>
              <Text style={typography.heading}>Pix Copia e Cola</Text>
              <Text style={typography.caption}>
                O código já inclui o valor exato — você não precisa digitar nada.
              </Text>
              <Text
                accessibilityLabel="Código Pix copia e cola"
                selectable
                numberOfLines={4}
                style={styles.brcode}
              >
                {payment.pixBrcode}
              </Text>
              <Button
                label={copied === 'brcode' ? 'Código copiado!' : 'Copiar código Pix'}
                color={theme.primary}
                onPress={() => void copyBrCode()}
              />
            </View>
          ) : null}

          <View style={styles.pixBox}>
            <Row label="Chave Pix da loja" value={payment.pixKeyMasked ?? '—'} />
            <Row label="Recebedor" value={menu.branding?.displayName ?? menu.branch.name} />
            <Text style={typography.caption}>
              A chave é exibida mascarada por segurança. Use o código Copia e Cola acima.
            </Text>
          </View>

          <View style={styles.steps}>
            <Text style={typography.heading}>Como pagar</Text>
            {[
              'Copie o código Pix acima.',
              'Abra o app do seu banco e escolha "Pix Copia e Cola".',
              'Cole o código e confirme — o valor já vem preenchido.',
              'Volte aqui e aguarde a confirmação da loja.',
            ].map((step, index) => (
              <View key={step} style={styles.step}>
                <View style={[styles.stepNumber, { backgroundColor: theme.primary }]}>
                  <Text style={styles.stepNumberText}>{index + 1}</Text>
                </View>
                <Text style={[typography.body, styles.stepText]}>{step}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      <Button
        label="Acompanhar pedido"
        variant="secondary"
        onPress={() => navigation.navigate('Tracking', { orderId, menu })}
        style={styles.tracking}
      />
    </ScrollView>
  );
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.ink100 },
  content: { padding: spacing.lg, gap: spacing.md },
  header: { alignItems: 'center', gap: spacing.xs },
  orderNumber: { fontSize: 32, fontWeight: '800', color: palette.ink900 },
  amountBox: {
    backgroundColor: palette.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
  },
  timer: { alignItems: 'center' },
  pixBox: { backgroundColor: palette.white, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  brcode: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: palette.ink700,
    backgroundColor: palette.ink100,
    padding: spacing.md,
    borderRadius: radius.sm,
  },
  steps: { backgroundColor: palette.white, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  step: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepNumber: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  stepNumberText: { color: palette.white, fontWeight: '700', fontSize: 13 },
  stepText: { flex: 1 },
  tracking: { marginTop: spacing.md },
});
