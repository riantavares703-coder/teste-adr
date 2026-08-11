import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  EmptyState,
  Notice,
  Price,
  ProductRow,
  QuantityStepper,
  Row,
  StickyBar,
  ThemeProvider,
  Touchable,
  adoptTheme,
  semantic,
  spacing,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useCart } from '../cart-context.js';
import type { ScreenProps } from '../navigation.js';
import { formatBRL } from '@plataforma/domain';

/**
 * CARRINHO.
 *
 * Uma responsabilidade: revisar e ajustar. A escolha de entrega/retirada e o
 * pagamento ficam no checkout — misturar tudo aqui produz a tela longa e
 * cansativa que o briefing pede para evitar.
 */
export function CartScreen({ route, navigation }: ScreenProps<'Cart'>) {
  const { menu } = route.params;
  const cart = useCart();
  const theme = useMemo(() => adoptTheme(menu.theme, menu.theme), [menu.theme]);

  return (
    <ThemeProvider value={theme}>
      <CartContent menu={menu} navigation={navigation} cart={cart} />
    </ThemeProvider>
  );
}

function CartContent({
  menu,
  navigation,
  cart,
}: {
  menu: ScreenProps<'Cart'>['route']['params']['menu'];
  navigation: ScreenProps<'Cart'>['navigation'];
  cart: ReturnType<typeof useCart>;
}) {
  const theme = useTheme();
  const { gutter } = useResponsive();

  const totals = cart.totals();
  const minOrderCents = menu.settings?.minOrderCents ?? 0;
  const subtotal = totals?.subtotalCents ?? 0;
  const belowMinimum = minOrderCents > 0 && subtotal < minOrderCents;

  if (cart.cart.lines.length === 0) {
    return (
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        <EmptyState
          icon="🛒"
          title="Seu carrinho está vazio"
          description="Adicione itens do cardápio para continuar."
          action={{ label: 'Ver cardápio', onPress: () => navigation.goBack() }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={{ padding: gutter, paddingBottom: spacing.xxxl }}>
        <Card padded={false} style={{ padding: gutter }}>
          {cart.cart.lines.map((line, index) => (
            <View
              key={line.key}
              style={[
                index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border } : null,
              ]}
            >
              <ProductRow
                title={line.name}
                imageUrl={line.imageUrl}
                subtitle={
                  [
                    line.options.map((o) => o.name).join(', ') || null,
                    line.notes ? `Obs.: ${line.notes}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || null
                }
                right={
                  <View style={styles.lineRight}>
                    <Price cents={(line.unitPriceCents + line.options.reduce((s, o) => s + o.priceDeltaCents, 0)) * line.quantity} size="sm" />
                    <QuantityStepper
                      value={line.quantity}
                      onChange={(next) => cart.changeQty(line.key, next - line.quantity)}
                      min={0}
                      max={line.maxQuantity}
                      compact
                    />
                  </View>
                }
              />
              {line.maxQuantity !== null && line.quantity >= line.maxQuantity ? (
                <Text style={[theme.font('caption'), { color: semantic.warning }]}>
                  Só há {line.maxQuantity} em estoque.
                </Text>
              ) : null}
            </View>
          ))}
        </Card>

        <Touchable
          onPress={() => navigation.goBack()}
          accessibilityLabel="Adicionar mais itens"
          style={{ paddingVertical: spacing.md }}
        >
          <Text style={[theme.font('subheading'), { color: theme.primary, textAlign: 'center' }]}>
            + Adicionar mais itens
          </Text>
        </Touchable>

        <Card>
          <Row label="Subtotal" value={formatBRL(subtotal)} />
          <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
            A taxa de entrega é calculada no próximo passo, conforme o endereço.
          </Text>
        </Card>

        {belowMinimum ? (
          <Notice tone="warning" title="Pedido mínimo não atingido">
            Esta unidade atende pedidos a partir de {formatBRL(minOrderCents)}. Faltam{' '}
            {formatBRL(minOrderCents - subtotal)}.
          </Notice>
        ) : null}
      </ScrollView>

      <SafeAreaView edges={['bottom']}>
        <StickyBar>
          <Row label="Total dos itens" value={formatBRL(subtotal)} strong />
          <Button
            label="Continuar"
            disabled={belowMinimum}
            onPress={() => navigation.navigate('Checkout', { menu })}
            accessibilityHint="Vai para a escolha de entrega e pagamento"
          />
        </StickyBar>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  lineRight: { alignItems: 'flex-end', gap: spacing.sm },
});
