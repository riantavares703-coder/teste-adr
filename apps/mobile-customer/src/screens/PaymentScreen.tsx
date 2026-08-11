import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import type { OrderDetail } from '@plataforma/client';
import {
  AsyncBoundary,
  Badge,
  Button,
  Card,
  Notice,
  Price,
  Row,
  SectionHeader,
  StickyBar,
  ThemeProvider,
  adoptTheme,
  radius,
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
 * PAGAMENTO.
 *
 * A tela mais delicada do app, por uma razão específica do briefing do Prompt
 * 01: *"Não assumir que copiar a chave Pix significa que o pagamento foi
 * confirmado."*
 *
 * Por isso o botão diz "Copiar código Pix" e NÃO "Pagar"; ao copiar, a
 * confirmação que aparece é sobre a CÓPIA, nunca sobre o pagamento; e o
 * estado do pagamento exibido vem sempre do servidor, que só muda quando a
 * loja confere o recebimento.
 *
 * Os dois estados aparecem lado a lado — pedido e pagamento — porque são
 * máquinas independentes (Prompt 02, item 7).
 */
export function PaymentScreen({ route, navigation }: ScreenProps<'Payment'>) {
  const { orderId, menu } = route.params;
  const theme = useMemo(() => adoptTheme(menu.theme, menu.theme), [menu.theme]);
  return (
    <ThemeProvider value={theme}>
      <PaymentContent orderId={orderId} menu={menu} navigation={navigation} />
    </ThemeProvider>
  );
}

function PaymentContent({
  orderId,
  menu,
  navigation,
}: {
  orderId: string;
  menu: ScreenProps<'Payment'>['route']['params']['menu'];
  navigation: ScreenProps<'Payment'>['navigation'];
}) {
  const theme = useTheme();
  const { gutter } = useResponsive();
  const { api } = useSession();

  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.getOrder(orderId));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, orderId]);

  useEffect(() => {
    void load();
    // Sondagem enquanto o pagamento não é confirmado. Em produção o WebSocket
    // empurra a mudança; a sondagem é a rede de segurança para quando o socket
    // cai — sem ela, o cliente fica olhando uma tela que nunca muda.
    const timer = setInterval(() => void load(), 12_000);
    return () => clearInterval(timer);
  }, [load]);

  const payment = detail?.payment ?? null;
  const order = detail?.order ?? null;
  const isPix = payment?.method === 'PIX';
  const confirmed = payment?.status === 'CONFIRMED';

  async function copyCode() {
    if (!payment?.pixBrcode) return;
    await Clipboard.setStringAsync(payment.pixBrcode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={() => void load()}
        onSessionExpired={() => navigation.navigate('Login')}
      >
        {order && payment ? (
          <>
            <ScrollView contentContainerStyle={{ padding: gutter, paddingBottom: spacing.xxxl }}>
              <Card>
                <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
                  Pedido #{order.orderNumber}
                </Text>
                <Price cents={order.totalCents} size="xl" color={theme.primary} />
                <View style={styles.badges}>
                  <Badge tone={toneForOrder(order.status)} />
                  <Badge tone={toneForPayment(payment.status)} />
                </View>
              </Card>

              {isPix && !confirmed ? (
                <>
                  <SectionHeader title="Pague com Pix" />
                  <Card>
                    <Text style={[theme.font('body'), { color: theme.mutedText }]}>
                      Copie o código abaixo e cole no aplicativo do seu banco, na opção
                      &ldquo;Pix Copia e Cola&rdquo;.
                    </Text>
                    <View style={[styles.code, { backgroundColor: theme.subtle }]}>
                      <Text
                        selectable
                        numberOfLines={4}
                        style={[theme.font('caption'), styles.codeText, { color: theme.text }]}
                      >
                        {payment.pixBrcode ?? '—'}
                      </Text>
                    </View>
                    <Button
                      label={copied ? 'Código copiado' : 'Copiar código Pix'}
                      icon={copied ? '✓' : '📋'}
                      variant={copied ? 'success' : 'primary'}
                      onPress={() => void copyCode()}
                      accessibilityHint="Copia o código Pix para a área de transferência"
                    />
                    {payment.pixKeyMasked ? (
                      <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
                        Chave da loja: {payment.pixKeyMasked}
                      </Text>
                    ) : null}
                  </Card>

                  {/*
                    O aviso mais importante da tela. `automaticConfirmation`
                    vem do servidor: enquanto não houver PSP integrado, ele é
                    falso e o texto diz a verdade — a loja confere na mão.
                  */}
                  <Notice tone="warning" title="Copiar o código não confirma o pagamento">
                    {payment.automaticConfirmation
                      ? 'Assim que o banco confirmar o recebimento, seu pedido avança automaticamente.'
                      : 'Depois de pagar no seu banco, a loja verifica o recebimento e confirma o pedido. Você verá a mudança aqui.'}
                  </Notice>
                </>
              ) : null}

              {!isPix ? (
                <Notice tone="info" title="Pagamento na entrega">
                  Você paga {payment.method === 'CASH_ON_SITE' ? 'em dinheiro' : 'no cartão'} ao
                  receber o pedido. Não é necessário pagar agora.
                </Notice>
              ) : null}

              {confirmed ? (
                <Notice tone="success" title="Pagamento confirmado">
                  A loja confirmou o recebimento em{' '}
                  {payment.confirmedAt ? formatDateTime(payment.confirmedAt) : 'instantes atrás'}.
                </Notice>
              ) : null}

              <SectionHeader title="Resumo" />
              <Card>
                <Row label="Subtotal" value={formatBRL(order.subtotalCents)} />
                {order.deliveryFeeCents > 0 ? (
                  <Row label="Entrega" value={formatBRL(order.deliveryFeeCents)} />
                ) : null}
                {order.discountCents > 0 ? (
                  <Row label="Desconto" value={`− ${formatBRL(order.discountCents)}`} />
                ) : null}
                <Row label="Total" value={formatBRL(order.totalCents)} strong />
              </Card>
            </ScrollView>

            <SafeAreaView edges={['bottom']}>
              <StickyBar>
                <Button
                  label="Acompanhar pedido"
                  onPress={() => navigation.replace('Tracking', { orderId, menu })}
                />
              </StickyBar>
            </SafeAreaView>
          </>
        ) : null}
      </AsyncBoundary>
    </View>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  badges: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm, flexWrap: 'wrap' },
  code: { borderRadius: radius.md, padding: spacing.md, marginVertical: spacing.md },
  codeText: { fontFamily: undefined, letterSpacing: 0.3 },
});
