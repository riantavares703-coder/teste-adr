import React, { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Menu } from '@plataforma/client';
import { toOrderItems, ApiError } from '@plataforma/client';
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from '@plataforma/domain';
import {
  Button,
  Notice,
  Price,
  QuantityStepper,
  Row,
  palette,
  radius,
  spacing,
  themeFromBranding,
  typography,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import { useCart } from '../cart-context.js';
import type { ScreenProps } from '../navigation.js';

/**
 * Carrinho + checkout (itens 5 e 6 do Prompt 02).
 *
 * O fluxo é: CARRINHO -> TIPO DE RECEBIMENTO -> PAGAMENTO -> CONFIRMAÇÃO.
 * Endereço só é pedido quando a modalidade é ENTREGA.
 *
 * Os valores mostrados aqui são PREVISÃO, calculados com a mesma função do
 * servidor. O valor cobrado é o que o servidor recalcular: se divergir, a API
 * devolve 409 e nós mostramos o novo total para o cliente confirmar.
 */
export function CartScreen({ route, navigation }: ScreenProps<'Cart'>) {
  const { menu } = route.params;
  const { api, isAuthenticated } = useSession();
  const { cart, changeQty, remove, clear, totals } = useCart();

  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>(
    menu.branch.acceptsPickup ? 'PICKUP' : 'DELIVERY',
  );
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('PIX');
  const [addressId, setAddressId] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState<{ actual: number } | null>(null);

  const theme = themeFromBranding(menu.branding);
  const methods = menu.settings?.enabledPaymentMethods ?? ['PIX'];

  // A taxa real vem do servidor; aqui é apenas previsão para a tela.
  const estimatedFee = fulfillment === 'DELIVERY' ? 700 : 0;
  const priced = useMemo(() => totals(estimatedFee), [totals, estimatedFee]);

  if (cart.lines.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={typography.heading}>Seu carrinho está vazio</Text>
        <Button label="Ver cardápio" variant="secondary" onPress={() => navigation.goBack()} />
      </View>
    );
  }

  async function submit() {
    if (!isAuthenticated) {
      navigation.navigate('Login', { returnTo: 'Cart' });
      return;
    }
    if (fulfillment === 'DELIVERY' && !addressId.trim()) {
      setError('Informe o endereço de entrega.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setPriceChanged(null);

    try {
      // Chave de idempotência gerada UMA vez por tentativa de finalização:
      // se a rede cair e o app repetir, o servidor devolve o mesmo pedido.
      const idempotencyKey = `${cart.branchId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const detail = await api.createOrder(
        {
          branchId: menu.branch.id,
          fulfillment,
          paymentMethod,
          items: toOrderItems(cart),
          deliveryAddressId: fulfillment === 'DELIVERY' ? addressId.trim() : undefined,
          customerNotes: notes.trim() || undefined,
          // Comparação, não cobrança.
          expectedTotalCents: priced ? priced.totalCents : undefined,
        },
        idempotencyKey,
      );

      clear();
      navigation.navigate(paymentMethod === 'PIX' ? 'Payment' : 'Tracking', {
        orderId: detail.order.id,
        menu,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRECO_ALTERADO') {
        const details = e.details as { actualTotalCents: number };
        setPriceChanged({ actual: details.actualTotalCents });
      } else if (e instanceof ApiError && e.code === 'PRODUTO_INDISPONIVEL') {
        setError('Um item do carrinho acabou de esgotar. Revise seu pedido.');
      } else {
        setError((e as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {cart.lines.map((line) => (
          <View key={line.key} style={styles.line}>
            {line.imageUrl ? (
              <Image
                source={{ uri: api.mediaUrl(line.imageUrl)! }}
                style={styles.thumb}
                accessibilityIgnoresInvertColors
              />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder]} />
            )}

            <View style={styles.lineInfo}>
              <Text style={typography.body} numberOfLines={1}>
                {line.name}
              </Text>
              {line.options.length > 0 ? (
                <Text style={typography.caption} numberOfLines={2}>
                  {line.options.map((o) => o.name).join(', ')}
                </Text>
              ) : null}
              {line.notes ? (
                <Text style={typography.caption} numberOfLines={1}>
                  Obs.: {line.notes}
                </Text>
              ) : null}
              <Text style={typography.caption}>
                Unitário: {formatBRL(line.unitPriceCents + line.options.reduce((a, o) => a + o.priceDeltaCents, 0))}
              </Text>

              <View style={styles.lineFooter}>
                <QuantityStepper
                  value={line.quantity}
                  onChange={(next) => changeQty(line.key, next - line.quantity)}
                  min={0}
                  max={line.maxQuantity}
                />
                <Price
                  cents={
                    (line.unitPriceCents + line.options.reduce((a, o) => a + o.priceDeltaCents, 0)) *
                    line.quantity
                  }
                />
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remover ${line.name}`}
                onPress={() => remove(line.key)}
              >
                <Text style={styles.removeLabel}>Remover</Text>
              </Pressable>
            </View>
          </View>
        ))}

        <Text style={[typography.heading, styles.sectionTitle]}>Como você quer receber?</Text>
        <View style={styles.choices}>
          {menu.branch.acceptsPickup ? (
            <Choice
              label="Retirada na loja"
              selected={fulfillment === 'PICKUP'}
              color={theme.primary}
              onPress={() => setFulfillment('PICKUP')}
            />
          ) : null}
          {menu.branch.acceptsDelivery ? (
            <Choice
              label="Entrega"
              selected={fulfillment === 'DELIVERY'}
              color={theme.primary}
              onPress={() => setFulfillment('DELIVERY')}
            />
          ) : null}
        </View>

        {/* Endereço só aparece na entrega — retirada não pede endereço. */}
        {fulfillment === 'DELIVERY' ? (
          <View style={styles.block}>
            <Text style={typography.body}>Endereço de entrega</Text>
            <TextInput
              accessibilityLabel="Identificador do endereço de entrega"
              placeholder="Selecione um endereço salvo"
              placeholderTextColor={palette.ink500}
              value={addressId}
              onChangeText={setAddressId}
              style={styles.input}
            />
            <Text style={typography.caption}>
              A taxa exibida é uma estimativa. O valor final é calculado pela loja conforme a zona
              de entrega.
            </Text>
          </View>
        ) : null}

        <Text style={[typography.heading, styles.sectionTitle]}>Pagamento</Text>
        <View style={styles.choices}>
          {methods.map((method) => (
            <Choice
              key={method}
              label={PAYMENT_METHOD_LABEL[method]}
              selected={paymentMethod === method}
              color={theme.primary}
              onPress={() => setPaymentMethod(method)}
            />
          ))}
        </View>

        <View style={styles.block}>
          <TextInput
            accessibilityLabel="Observações do pedido"
            placeholder="Observações para a loja (opcional)"
            placeholderTextColor={palette.ink500}
            value={notes}
            onChangeText={setNotes}
            maxLength={500}
            multiline
            style={[styles.input, styles.inputMultiline]}
          />
        </View>

        <View style={styles.summary}>
          <Row label="Subtotal" value={formatBRL(priced?.subtotalCents ?? 0)} />
          {fulfillment === 'DELIVERY' ? (
            <Row label="Taxa de entrega (estimada)" value={formatBRL(estimatedFee)} />
          ) : null}
          <Row label="Desconto" value={formatBRL(priced?.discountCents ?? 0)} />
          <View style={styles.divider} />
          <Row label="Total" value={formatBRL(priced?.totalCents ?? 0)} strong />
        </View>

        {priceChanged ? (
          <Notice tone="warning">
            Os valores mudaram. O novo total é {formatBRL(priceChanged.actual)}. Toque em finalizar
            novamente para confirmar.
          </Notice>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </ScrollView>

      <View style={styles.footer}>
        <Button
          label={submitting ? 'Enviando…' : 'Finalizar pedido'}
          color={theme.primary}
          loading={submitting}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

function Choice({
  label,
  selected,
  color,
  onPress,
}: {
  label: string;
  selected: boolean;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.choice, selected && { borderColor: color, backgroundColor: `${color}12` }]}
    >
      <Text style={[typography.body, selected && { color, fontWeight: '700' }]}>{label}</Text>
    </Pressable>
  );
}

function formatBRL(cents: number): string {
  return `R$ ${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.ink100 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
  line: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: palette.white,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  thumb: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: palette.ink300 },
  thumbPlaceholder: {},
  lineInfo: { flex: 1, gap: spacing.xs },
  lineFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  removeLabel: { color: palette.danger, fontSize: 13, fontWeight: '600', paddingVertical: spacing.sm },
  sectionTitle: { marginTop: spacing.lg, marginBottom: spacing.sm },
  choices: { gap: spacing.sm },
  choice: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: palette.ink300,
    borderRadius: radius.md,
    backgroundColor: palette.white,
  },
  block: { marginTop: spacing.md, gap: spacing.sm },
  input: {
    backgroundColor: palette.white,
    borderWidth: 1,
    borderColor: palette.ink300,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 48,
    color: palette.ink900,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  summary: {
    marginTop: spacing.xl,
    backgroundColor: palette.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  divider: { height: 1, backgroundColor: palette.ink100, marginVertical: spacing.sm },
  footer: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: palette.ink300, backgroundColor: palette.white },
});
