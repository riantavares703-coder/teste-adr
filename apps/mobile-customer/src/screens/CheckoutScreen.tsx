import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatBRL, type PaymentMethod } from '@plataforma/domain';
import { toOrderItems } from '@plataforma/client';
import {
  Button,
  Card,
  Field,
  Notice,
  Row,
  SectionHeader,
  SegmentedControl,
  StickyBar,
  ThemeProvider,
  Touchable,
  adoptTheme,
  friendlyMessage,
  radius,
  spacing,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import { useCart } from '../cart-context.js';
import type { ScreenProps } from '../navigation.js';

/**
 * CHECKOUT — retirada/entrega + pagamento, em UMA tela.
 *
 * Duas decisões, dois controles, um botão. O fluxo do item 6 pede exatamente
 * isso; separar em duas telas adiciona uma transição sem adicionar clareza.
 *
 * O que NÃO acontece aqui: cálculo de cobrança. O app envia
 * `expectedTotalCents` só para DETECTAR divergência — se o preço mudou entre
 * montar o carrinho e finalizar, o servidor recusa com 409 e o cliente
 * confirma o novo valor. Nenhum valor enviado pelo app vira preço.
 */
const METHOD_LABEL: Record<string, string> = {
  PIX: 'Pix',
  CASH_ON_SITE: 'Dinheiro',
  CREDIT_ON_SITE: 'Crédito na entrega',
  DEBIT_ON_SITE: 'Débito na entrega',
};

export function CheckoutScreen({ route, navigation }: ScreenProps<'Checkout'>) {
  const { menu } = route.params;
  const theme = useMemo(() => adoptTheme(menu.theme, menu.theme), [menu.theme]);
  return (
    <ThemeProvider value={theme}>
      <CheckoutContent menu={menu} navigation={navigation} />
    </ThemeProvider>
  );
}

function CheckoutContent({
  menu,
  navigation,
}: {
  menu: ScreenProps<'Checkout'>['route']['params']['menu'];
  navigation: ScreenProps<'Checkout'>['navigation'];
}) {
  const theme = useTheme();
  const { gutter } = useResponsive();
  const { api, isAuthenticated } = useSession();
  const cart = useCart();

  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>(
    menu.branch.acceptsDelivery ? 'DELIVERY' : 'PICKUP',
  );
  const [method, setMethod] = useState<PaymentMethod>(
    (menu.settings?.enabledPaymentMethods?.[0] as PaymentMethod) ?? 'PIX',
  );
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotal = cart.totals()?.subtotalCents ?? 0;
  const methods = menu.settings?.enabledPaymentMethods ?? ['PIX'];

  async function submit() {
    if (!isAuthenticated) {
      navigation.navigate('Login');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const order = await api.createOrder(
        {
          branchId: menu.branch.id,
          fulfillment,
          paymentMethod: method,
          items: toOrderItems(cart.cart),
          customerNotes: notes.trim() || undefined,
          // Só para detecção de divergência. O servidor recalcula do zero.
          expectedTotalCents: subtotal,
        },
        // Chave de idempotência por TENTATIVA: se a resposta se perder na rede
        // e o cliente tocar de novo, o servidor devolve o MESMO pedido em vez
        // de criar um segundo e reservar estoque duas vezes.
        idempotencyKey(),
      );
      cart.clear();
      navigation.replace('Payment', { orderId: order.order.id, menu });
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={{ padding: gutter, paddingBottom: spacing.xxxl }}>
        <SectionHeader title="Como você quer receber?" />
        <SegmentedControl
          label="Forma de recebimento"
          value={fulfillment}
          onChange={setFulfillment}
          options={[
            {
              value: 'DELIVERY',
              label: 'Entrega',
              icon: '🛵',
              disabled: !menu.branch.acceptsDelivery,
            },
            {
              value: 'PICKUP',
              label: 'Retirada',
              icon: '🏪',
              disabled: !menu.branch.acceptsPickup,
            },
          ]}
        />

        {fulfillment === 'DELIVERY' ? (
          <Notice tone="info" title="Endereço de entrega">
            A taxa e a área de cobertura são confirmadas pelo servidor ao finalizar. Cadastre o
            endereço no seu perfil para agilizar.
          </Notice>
        ) : (
          <Card>
            <Text style={theme.font('subheading')}>Retirar em</Text>
            <Text style={[theme.font('body'), { color: theme.mutedText }]}>
              {menu.branch.name}
              {menu.branch.district ? ` · ${menu.branch.district}` : ''}
              {menu.branch.city ? ` · ${menu.branch.city}` : ''}
            </Text>
          </Card>
        )}

        <SectionHeader title="Pagamento" />
        <View style={styles.methods}>
          {methods.map((m) => {
            const selected = m === method;
            return (
              <Touchable
                key={m}
                onPress={() => setMethod(m as PaymentMethod)}
                accessibilityRole="radio"
                accessibilityLabel={METHOD_LABEL[m] ?? m}
                accessibilityState={{ selected }}
                scaleTo={0.99}
              >
                <View
                  style={[
                    styles.method,
                    {
                      backgroundColor: theme.card,
                      borderColor: selected ? theme.primary : theme.border,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.radio,
                      { borderColor: selected ? theme.primary : theme.border },
                    ]}
                  >
                    {selected ? (
                      <View style={[styles.radioDot, { backgroundColor: theme.primary }]} />
                    ) : null}
                  </View>
                  <Text style={[theme.font('body'), styles.flex]}>{METHOD_LABEL[m] ?? m}</Text>
                </View>
              </Touchable>
            );
          })}
        </View>

        {method === 'PIX' ? (
          <Notice tone="warning" title="Sobre o Pix">
            O código é gerado na próxima tela. O pedido só é confirmado quando a loja verificar o
            recebimento — copiar o código não confirma o pagamento.
          </Notice>
        ) : null}

        <Card>
          <Field
            label="Observação do pedido"
            placeholder="Ex.: interfone quebrado, entregar na portaria…"
            value={notes}
            onChangeText={setNotes}
            multiline
            maxLength={500}
          />
        </Card>

        {error ? <Notice tone="danger">{error}</Notice> : null}
      </ScrollView>

      <SafeAreaView edges={['bottom']}>
        <StickyBar>
          <Row label="Itens" value={formatBRL(subtotal)} />
          <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
            O total final, com taxa de entrega, é calculado pelo servidor.
          </Text>
          <Button
            label={isAuthenticated ? 'Finalizar pedido' : 'Entrar para finalizar'}
            loading={submitting}
            disabled={cart.cart.lines.length === 0}
            onPress={() => void submit()}
          />
        </StickyBar>
      </SafeAreaView>
    </View>
  );
}

/**
 * Chave de idempotência.
 *
 * `crypto.randomUUID` não existe no Hermes; montamos a partir de
 * `Math.random`. Não precisa ser imprevisível — precisa ser ÚNICA por
 * tentativa, e o servidor a usa apenas como chave de deduplicação.
 */
function idempotencyKey(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  methods: { gap: spacing.sm },
  method: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 56,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill },
});
