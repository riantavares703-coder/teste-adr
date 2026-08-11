import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ProductDetail } from '@plataforma/client';
import { validateSelection, type CartOption } from '@plataforma/client';
import {
  AsyncBoundary,
  Button,
  Card,
  Field,
  Notice,
  Price,
  QuantityStepper,
  SectionHeader,
  StickyBar,
  ThemeProvider,
  Touchable,
  adoptTheme,
  radius,
  spacing,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { ORGANIZATION_SLUG } from '../config.js';
import { useSession } from '../session.js';
import { useCart } from '../cart-context.js';
import type { ScreenProps } from '../navigation.js';
import { formatBRL } from '@plataforma/domain';

/**
 * PÁGINA DO PRODUTO.
 *
 * Foto grande, preço, adicionais e observação. O botão de adicionar fica FIXO
 * no rodapé com o total já calculado — o cliente não precisa rolar de volta
 * para descobrir quanto vai pagar depois de escolher três adicionais.
 *
 * O total mostrado aqui é OTIMISTA. Quem cobra é o servidor, que recalcula
 * tudo no checkout a partir do preço do banco (Prompt 02, item 6). Este número
 * existe para o cliente decidir, não para virar cobrança.
 */
export function ProductScreen({ route, navigation }: ScreenProps<'Product'>) {
  const { productId, menu } = route.params;
  const { api } = useSession();
  const cart = useCart();
  const { gutter, width } = useResponsive();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [quantity, setQuantity] = useState(1);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState('');

  const theme = useMemo(() => adoptTheme(menu.theme, menu.theme), [menu.theme]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProduct(await api.getProduct(productId));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const options: CartOption[] = useMemo(() => {
    if (!product) return [];
    return product.modifierGroups.flatMap((group) =>
      (selected[group.id] ?? []).flatMap((optionId) => {
        const option = group.options.find((o) => o.id === optionId);
        return option
          ? [
              {
                id: option.id,
                name: option.name,
                priceDeltaCents: option.priceDeltaCents,
                groupName: group.name,
              },
            ]
          : [];
      }),
    );
  }, [product, selected]);

  const selectedIds = useMemo(() => options.map((o) => o.id), [options]);

  /**
   * Validação das escolhas obrigatórias.
   *
   * Roda no app para dar retorno imediato — e roda DE NOVO no servidor. O app
   * evita a viagem inútil; o servidor é quem decide (item 10: "validar toda
   * operação no backend").
   */
  const validation = useMemo(
    () => (product ? validateSelection(product.modifierGroups, selectedIds) : { ok: true as const }),
    [product, selectedIds],
  );

  const unitCents = (product?.priceCents ?? 0) + options.reduce((s, o) => s + o.priceDeltaCents, 0);
  const totalCents = unitCents * quantity;
  const available = product?.availability.isPurchasable ?? false;

  function toggle(groupId: string, optionId: string, maxSelect: number) {
    setSelected((current) => {
      const list = current[groupId] ?? [];
      if (list.includes(optionId)) {
        return { ...current, [groupId]: list.filter((id) => id !== optionId) };
      }
      // Grupo de escolha única troca em vez de acumular — evita o estado
      // "escolhi dois de um grupo que aceita um" que o servidor recusaria.
      if (maxSelect === 1) return { ...current, [groupId]: [optionId] };
      if (list.length >= maxSelect) return current;
      return { ...current, [groupId]: [...list, optionId] };
    });
  }

  function addAndReturn() {
    if (!product) return;
    cart.add({
      product: {
        id: product.id,
        name: product.name,
        description: product.description,
        priceCents: product.priceCents,
        categoryId: null,
        isFeatured: product.isFeatured,
        allowsCustomerNotes: product.allowsCustomerNotes,
        imageUrl: product.imageUrl,
        thumbUrl: product.imageUrl,
        availability: product.availability,
      },
      branchId: menu.branch.id,
      organizationSlug: ORGANIZATION_SLUG,
      branchSlug: menu.branch.slug,
      quantity,
      selectedOptions: options,
      notes: notes.trim() || undefined,
    });
    navigation.goBack();
  }

  return (
    <ThemeProvider value={theme}>
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        <AsyncBoundary loading={loading} error={error} onRetry={() => void load()}>
          {product ? (
            <>
              <ScrollView contentContainerStyle={{ paddingBottom: spacing.xxxl }}>
                <View style={{ height: Math.min(width * 0.75, 340), backgroundColor: theme.subtle }}>
                  {product.imageUrl ? (
                    <Image
                      source={{ uri: product.imageUrl }}
                      style={[styles.hero, !available && styles.dimmed]}
                      resizeMode="cover"
                      accessibilityIgnoresInvertColors
                      accessible
                      accessibilityLabel={`Foto de ${product.name}`}
                    />
                  ) : (
                    <View style={[styles.hero, styles.heroPlaceholder]}>
                      <Text style={styles.heroGlyph}>🍔</Text>
                    </View>
                  )}
                  {!available ? (
                    <View style={styles.soldOut}>
                      <View style={styles.soldOutPill}>
                        <Text style={styles.soldOutText}>ESGOTADO</Text>
                      </View>
                    </View>
                  ) : null}
                </View>

                <View style={{ padding: gutter, gap: spacing.md }}>
                  <View style={styles.titleRow}>
                    <Text style={[theme.font('title'), styles.flex]}>{product.name}</Text>
                    <Price cents={product.priceCents} size="lg" color={theme.primary} />
                  </View>

                  {product.description ? (
                    <Text style={[theme.font('body'), { color: theme.mutedText }]}>
                      {product.description}
                    </Text>
                  ) : null}

                  {!available ? (
                    <Notice tone="warning" title="Item indisponível">
                      Este produto está esgotado nesta unidade no momento.
                    </Notice>
                  ) : null}

                  {product.modifierGroups.map((group) => (
                    <View key={group.id}>
                      <SectionHeader title={group.name} />
                      <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
                        {group.isRequired
                          ? `Escolha ${group.minSelect === group.maxSelect ? group.minSelect : `de ${group.minSelect} a ${group.maxSelect}`}`
                          : `Opcional · até ${group.maxSelect}`}
                      </Text>
                      <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
                        {group.options.map((option) => {
                          const isOn = (selected[group.id] ?? []).includes(option.id);
                          return (
                            <Touchable
                              key={option.id}
                              onPress={() => toggle(group.id, option.id, group.maxSelect)}
                              accessibilityRole="checkbox"
                              accessibilityLabel={option.name}
                              accessibilityState={{ selected: isOn }}
                              scaleTo={0.99}
                            >
                              <View
                                style={[
                                  styles.option,
                                  {
                                    backgroundColor: theme.card,
                                    borderColor: isOn ? theme.primary : theme.border,
                                  },
                                ]}
                              >
                                <View
                                  style={[
                                    styles.checkbox,
                                    {
                                      borderColor: isOn ? theme.primary : theme.border,
                                      backgroundColor: isOn ? theme.primary : 'transparent',
                                    },
                                  ]}
                                >
                                  {isOn ? (
                                    <Text style={{ color: theme.onPrimary, fontSize: 13 }}>✓</Text>
                                  ) : null}
                                </View>
                                <Text style={[theme.font('body'), styles.flex]}>{option.name}</Text>
                                {option.priceDeltaCents !== 0 ? (
                                  <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
                                    {option.priceDeltaCents > 0 ? '+ ' : '− '}
                                    {formatBRL(Math.abs(option.priceDeltaCents))}
                                  </Text>
                                ) : null}
                              </View>
                            </Touchable>
                          );
                        })}
                      </View>
                    </View>
                  ))}

                  {product.allowsCustomerNotes ? (
                    <Card>
                      <Field
                        label="Observação"
                        placeholder="Ex.: sem cebola, ponto da carne…"
                        value={notes}
                        onChangeText={setNotes}
                        multiline
                        maxLength={200}
                        hint={`${notes.length}/200 · a cozinha vê esta anotação`}
                      />
                    </Card>
                  ) : null}

                  {!validation.ok ? (
                    <Notice tone="warning">{validation.message}</Notice>
                  ) : null}
                </View>
              </ScrollView>

              <SafeAreaView edges={['bottom']}>
                <StickyBar>
                  <View style={styles.actionRow}>
                    <QuantityStepper value={quantity} onChange={setQuantity} min={1} max={99} />
                    <View style={styles.flex}>
                      <Button
                        label={available ? `Adicionar · ${formatBRL(totalCents)}` : 'Esgotado'}
                        disabled={!available || !validation.ok}
                        onPress={addAndReturn}
                        accessibilityHint="Adiciona o item ao carrinho e volta ao cardápio"
                      />
                    </View>
                  </View>
                </StickyBar>
              </SafeAreaView>
            </>
          ) : null}
        </AsyncBoundary>
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  hero: { width: '100%', height: '100%' },
  dimmed: { opacity: 0.35 },
  heroPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  heroGlyph: { fontSize: 56, opacity: 0.3 },
  soldOut: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  soldOutPill: {
    backgroundColor: '#111827e6',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  soldOutText: { color: '#fff', fontWeight: '800', letterSpacing: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 56,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.xs,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errors: { gap: spacing.xs },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
