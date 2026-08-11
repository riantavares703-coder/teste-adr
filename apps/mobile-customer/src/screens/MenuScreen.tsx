import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Menu, MenuProduct } from '@plataforma/client';
import {
  Badge,
  Button,
  ErrorState,
  Loading,
  Price,
  palette,
  radius,
  spacing,
  themeFromBranding,
  typography,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import { useCart } from '../cart-context.js';
import type { ScreenProps } from '../navigation.js';

const ORGANIZATION_SLUG = 'acme';
const BRANCH_SLUG = 'centro';

/**
 * Vitrine + cardápio (item 1 do Prompt 02).
 *
 * A disponibilidade vem do servidor a cada carga — nunca é cacheada junto do
 * cardápio. Produto esgotado aparece visivelmente indisponível e não pode ser
 * adicionado; ainda assim, é o checkout que decide, com reserva atômica.
 */
export function MenuScreen({ navigation }: ScreenProps<'Menu'>) {
  const { api } = useSession();
  const { count } = useCart();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setMenu(await api.getMenu(ORGANIZATION_SLUG, BRANCH_SLUG));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!menu) return <Loading label="Carregando cardápio…" />;

  const theme = themeFromBranding(menu.branding);
  const isClosed = menu.branch.status !== 'ACTIVE';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
        contentContainerStyle={styles.content}
      >
        <View style={[styles.hero, { backgroundColor: theme.primary }]}>
          <Text style={styles.heroTitle}>{menu.branding?.displayName ?? menu.branch.name}</Text>
          {menu.branding?.tagline ? (
            <Text style={styles.heroSubtitle}>{menu.branding.tagline}</Text>
          ) : null}
          <View style={styles.heroMeta}>
            {menu.branch.acceptsPickup ? <Chip label="Retirada" /> : null}
            {menu.branch.acceptsDelivery ? <Chip label="Entrega" /> : null}
            {menu.settings ? <Chip label={`~${menu.settings.preparationTimeMinutes} min`} /> : null}
          </View>
        </View>

        {isClosed ? (
          <View style={styles.closed}>
            <Text style={[typography.heading, { color: palette.danger }]}>
              A loja não está aceitando pedidos agora
            </Text>
          </View>
        ) : null}

        {menu.featured.length > 0 ? (
          <Section title="Destaques">
            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              data={menu.featured}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.featuredRow}
              renderItem={({ item }) => (
                <FeaturedCard
                  product={item}
                  imageUrl={api.mediaUrl(item.thumbUrl ?? item.imageUrl)}
                  onPress={() => navigation.navigate('Product', { productId: item.id, menu })}
                />
              )}
            />
          </Section>
        ) : null}

        {menu.categories
          .filter((category) => category.products.length > 0)
          .map((category) => (
            <Section key={category.id} title={category.name} subtitle={category.description}>
              {category.products.map((product) => (
                <ProductRow
                  key={product.id}
                  product={product}
                  imageUrl={api.mediaUrl(product.thumbUrl ?? product.imageUrl)}
                  onPress={() => navigation.navigate('Product', { productId: product.id, menu })}
                />
              ))}
            </Section>
          ))}

        {menu.uncategorized.length > 0 ? (
          <Section title="Outros">
            {menu.uncategorized.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                imageUrl={api.mediaUrl(product.thumbUrl ?? product.imageUrl)}
                onPress={() => navigation.navigate('Product', { productId: product.id, menu })}
              />
            ))}
          </Section>
        ) : null}
      </ScrollView>

      {count > 0 ? (
        <View style={styles.cartBar}>
          <Button
            label={`Ver carrinho (${count})`}
            color={theme.primary}
            onPress={() => navigation.navigate('Cart', { menu })}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string | null;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={typography.heading}>{title}</Text>
      {subtitle ? <Text style={typography.caption}>{subtitle}</Text> : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

/**
 * Card do produto — exatamente o formato pedido no briefing:
 * [ FOTO ] / X-Burger / "Pão brioche…" / R$ 29,90 / [ ADICIONAR ]
 */
function ProductRow({
  product,
  imageUrl,
  onPress,
}: {
  product: MenuProduct;
  imageUrl: string | null;
  onPress: () => void;
}) {
  const unavailable = !product.availability.isPurchasable;
  const remaining = product.availability.availableQuantity;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${formatBRL(product.priceCents)}${unavailable ? ', esgotado' : ''}`}
      onPress={unavailable ? undefined : onPress}
      style={({ pressed }) => [
        styles.productRow,
        unavailable && styles.productUnavailable,
        pressed && !unavailable && styles.productPressed,
      ]}
    >
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={styles.productImage} accessibilityIgnoresInvertColors />
      ) : (
        <View style={[styles.productImage, styles.productImagePlaceholder]} />
      )}

      <View style={styles.productInfo}>
        <Text style={typography.heading} numberOfLines={1}>
          {product.name}
        </Text>
        {product.description ? (
          <Text style={typography.caption} numberOfLines={2}>
            {product.description}
          </Text>
        ) : null}
        <View style={styles.productFooter}>
          <Price cents={product.priceCents} />
          {unavailable ? (
            <Badge label="Esgotado" fg={palette.danger} bg={palette.dangerBg} />
          ) : remaining !== null && remaining <= 5 ? (
            <Badge label={`Restam ${remaining}`} fg={palette.warning} bg={palette.warningBg} />
          ) : (
            <Text style={styles.addHint}>ADICIONAR</Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function FeaturedCard({
  product,
  imageUrl,
  onPress,
}: {
  product: MenuProduct;
  imageUrl: string | null;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.featuredCard}>
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={styles.featuredImage} accessibilityIgnoresInvertColors />
      ) : (
        <View style={[styles.featuredImage, styles.productImagePlaceholder]} />
      )}
      <Text style={styles.featuredName} numberOfLines={1}>
        {product.name}
      </Text>
      <Price cents={product.priceCents} size="sm" />
    </Pressable>
  );
}

function formatBRL(cents: number): string {
  return `R$ ${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.ink100 },
  content: { paddingBottom: 96 },
  hero: { padding: spacing.xl, paddingTop: spacing.lg },
  heroTitle: { fontSize: 26, fontWeight: '800', color: palette.white },
  heroSubtitle: { fontSize: 14, color: palette.white, opacity: 0.9, marginTop: spacing.xs },
  heroMeta: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipLabel: { color: palette.white, fontSize: 12, fontWeight: '600' },
  closed: { padding: spacing.lg, backgroundColor: palette.dangerBg, alignItems: 'center' },
  section: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl },
  sectionBody: { marginTop: spacing.md },
  featuredRow: { gap: spacing.md, paddingRight: spacing.lg },
  featuredCard: { width: 140 },
  featuredImage: { width: 140, height: 100, borderRadius: radius.md, backgroundColor: palette.ink300 },
  featuredName: { ...typography.body, fontWeight: '600', marginTop: spacing.sm },
  productRow: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: palette.white,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: palette.ink100,
  },
  productPressed: { opacity: 0.85 },
  productUnavailable: { opacity: 0.55 },
  productImage: { width: 88, height: 88, borderRadius: radius.md, backgroundColor: palette.ink300 },
  productImagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  productInfo: { flex: 1, justifyContent: 'space-between' },
  productFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  addHint: { fontSize: 12, fontWeight: '800', color: palette.brand, letterSpacing: 0.5 },
  cartBar: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
  },
});
