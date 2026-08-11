import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Menu, ProductDetail } from '@plataforma/client';
import { validateSelection } from '@plataforma/client';
import {
  Button,
  ErrorState,
  Loading,
  Notice,
  Price,
  QuantityStepper,
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
 * Página do produto (item 1): foto, nome, descrição, preço, adicionais e
 * observações. A quantidade máxima respeita o estoque quando o produto o
 * controla — mas quem decide de fato é o servidor, na reserva atômica.
 */
export function ProductScreen({ route, navigation }: ScreenProps<'Product'>) {
  const { productId, menu } = route.params;
  const { api } = useSession();
  const { add } = useCart();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  const theme = themeFromBranding(menu.branding);

  useEffect(() => {
    api
      .getProduct(productId)
      .then(setProduct)
      .catch((e: Error) => setError(e.message));
  }, [api, productId]);

  const selectedOptions = useMemo(() => {
    if (!product) return [];
    return product.modifierGroups.flatMap((group) =>
      group.options
        .filter((option) => selectedIds.includes(option.id))
        .map((option) => ({
          id: option.id,
          name: option.name,
          priceDeltaCents: option.priceDeltaCents,
          groupName: group.name,
        })),
    );
  }, [product, selectedIds]);

  const unitTotal = useMemo(() => {
    if (!product) return 0;
    const extras = selectedOptions.reduce((acc, o) => acc + o.priceDeltaCents, 0);
    return (product.priceCents + extras) * quantity;
  }, [product, selectedOptions, quantity]);

  if (error) return <ErrorState message={error} />;
  if (!product) return <Loading />;

  const maxQuantity = product.availability.availableQuantity;
  const unavailable = !product.availability.isPurchasable;

  function toggleOption(groupId: string, optionId: string, maxSelect: number) {
    setValidation(null);
    setSelectedIds((current) => {
      if (current.includes(optionId)) return current.filter((id) => id !== optionId);

      const group = product!.modifierGroups.find((g) => g.id === groupId)!;
      const idsInGroup = group.options.map((o) => o.id);
      const chosenInGroup = current.filter((id) => idsInGroup.includes(id));

      // Grupo de escolha única: a nova seleção substitui a anterior.
      if (maxSelect === 1) {
        return [...current.filter((id) => !idsInGroup.includes(id)), optionId];
      }
      if (chosenInGroup.length >= maxSelect) return current;
      return [...current, optionId];
    });
  }

  function handleAdd() {
    const check = validateSelection(product!.modifierGroups, selectedIds);
    if (!check.ok) {
      setValidation(check.message);
      return;
    }

    add({
      product: {
        ...product!,
        categoryId: null,
        thumbUrl: product!.images[0]?.thumbUrl ?? null,
        imageUrl: product!.images[0]?.url ?? null,
      },
      branchId: menu.branch.id,
      organizationSlug: 'acme',
      branchSlug: menu.branch.slug,
      quantity,
      selectedOptions,
      notes: notes.trim() || undefined,
    });
    navigation.goBack();
  }

  const cover = api.mediaUrl(product.images[0]?.url ?? null);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.cover} accessibilityIgnoresInvertColors />
        ) : (
          <View style={[styles.cover, styles.coverPlaceholder]} />
        )}

        <View style={styles.body}>
          <Text style={typography.title}>{product.name}</Text>
          {product.description ? (
            <Text style={[typography.body, styles.description]}>{product.description}</Text>
          ) : null}
          <Price cents={product.priceCents} size="lg" />

          {unavailable ? (
            <Notice tone="danger">
              Este item está esgotado no momento e não pode ser adicionado.
            </Notice>
          ) : maxQuantity !== null && maxQuantity <= 5 ? (
            <Notice tone="warning">Restam apenas {maxQuantity} unidades.</Notice>
          ) : null}

          {product.modifierGroups.map((group) => (
            <View key={group.id} style={styles.group}>
              <View style={styles.groupHeader}>
                <Text style={typography.heading}>{group.name}</Text>
                <Text style={typography.caption}>
                  {group.isRequired ? 'Obrigatório' : 'Opcional'}
                  {group.maxSelect > 1 ? ` · até ${group.maxSelect}` : ''}
                </Text>
              </View>

              {group.options.map((option) => {
                const selected = selectedIds.includes(option.id);
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={option.name}
                    onPress={() => toggleOption(group.id, option.id, group.maxSelect)}
                    style={[styles.option, selected && { borderColor: theme.primary }]}
                  >
                    <View
                      style={[
                        styles.optionMark,
                        selected && { backgroundColor: theme.primary, borderColor: theme.primary },
                      ]}
                    />
                    <Text style={[typography.body, styles.optionName]}>{option.name}</Text>
                    {option.priceDeltaCents !== 0 ? (
                      <Text style={typography.caption}>
                        {option.priceDeltaCents > 0 ? '+ ' : '− '}
                        {formatBRL(Math.abs(option.priceDeltaCents))}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))}

          {product.allowsCustomerNotes ? (
            <View style={styles.group}>
              <Text style={typography.heading}>Observações</Text>
              <TextInput
                accessibilityLabel="Observações do item"
                placeholder="Ex.: sem cebola"
                placeholderTextColor={palette.ink500}
                value={notes}
                onChangeText={setNotes}
                maxLength={200}
                multiline
                style={styles.notes}
              />
            </View>
          ) : null}

          {validation ? <Notice tone="danger">{validation}</Notice> : null}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <QuantityStepper value={quantity} onChange={setQuantity} min={1} max={maxQuantity} />
        <Button
          label={`Adicionar · ${formatBRL(unitTotal)}`}
          color={theme.primary}
          disabled={unavailable}
          onPress={handleAdd}
          style={styles.addButton}
        />
      </View>
    </View>
  );
}

function formatBRL(cents: number): string {
  return `R$ ${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.white },
  content: { paddingBottom: spacing.xxl },
  cover: { width: '100%', height: 260, backgroundColor: palette.ink300 },
  coverPlaceholder: {},
  body: { padding: spacing.lg, gap: spacing.sm },
  description: { marginBottom: spacing.sm },
  group: { marginTop: spacing.xl, gap: spacing.sm },
  groupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: palette.ink300,
    borderRadius: radius.md,
  },
  optionMark: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: palette.ink300,
  },
  optionName: { flex: 1 },
  notes: {
    borderWidth: 1,
    borderColor: palette.ink300,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 80,
    textAlignVertical: 'top',
    color: palette.ink900,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: palette.ink100,
    backgroundColor: palette.white,
  },
  addButton: { flex: 1 },
});
