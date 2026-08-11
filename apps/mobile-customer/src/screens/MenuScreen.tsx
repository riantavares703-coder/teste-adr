import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Menu, MenuProduct } from '@plataforma/client';
import {
  AsyncBoundary,
  BrandHeader,
  Button,
  Chip,
  EmptyState,
  FadeIn,
  Notice,
  Price,
  ProductCard,
  ProductCardSkeleton,
  SectionHeader,
  StickyBar,
  ThemeProvider,
  Touchable,
  adoptTheme,
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
 * CARDÁPIO — o item 5.
 *
 * Estrutura da tela, de cima para baixo:
 *   marca → busca/categorias → destaques → seções por categoria → barra do carrinho
 *
 * O tema vem do servidor JUNTO com o cardápio (uma requisição, não duas), e é
 * aplicado a partir daqui para baixo. Por isso o `ThemeProvider` fica DENTRO
 * desta tela e não na raiz do app: só depois de escolher a unidade é que
 * existe uma marca a aplicar.
 */
export function MenuScreen({ route, navigation }: ScreenProps<'Menu'>) {
  const { branch } = route.params;
  const { api } = useSession();

  const [menu, setMenu] = useState<Menu | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        // A disponibilidade nunca é cacheada: cada abertura do cardápio relê o
        // estoque. Mostrar item esgotado como disponível é o defeito que o
        // cliente percebe como "o app mentiu".
        setMenu(await api.getMenu(ORGANIZATION_SLUG, branch.slug));
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api, branch.slug],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // O tema chega pronto do servidor — aqui só é adotado.
  const theme = useMemo(() => (menu ? adoptTheme(menu.theme, menu.theme) : undefined), [menu]);

  return (
    <ThemeProvider value={theme}>
      <MenuContent
        menu={menu}
        loading={loading}
        refreshing={refreshing}
        error={error}
        branchName={branch.name}
        onRefresh={() => void load('refresh')}
        onRetry={() => void load()}
        navigation={navigation}
      />
    </ThemeProvider>
  );
}

function MenuContent({
  menu,
  loading,
  refreshing,
  error,
  branchName,
  onRefresh,
  onRetry,
  navigation,
}: {
  menu: Menu | null;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  branchName: string;
  onRefresh: () => void;
  onRetry: () => void;
  navigation: ScreenProps<'Menu'>['navigation'];
}) {
  const theme = useTheme();
  const { gutter, cardImageHeight } = useResponsive();
  const cart = useCart();
  const listRef = useRef<SectionList<MenuProduct> | null>(null);

  const [category, setCategory] = useState<string | null>(null);

  const sections = useMemo(() => {
    if (!menu) return [];
    const all = menu.categories
      .filter((c) => c.products.length > 0)
      .map((c) => ({ id: c.id, title: c.name, data: c.products }));
    if (menu.uncategorized.length > 0) {
      all.push({ id: 'outros', title: 'Outros', data: menu.uncategorized });
    }
    return category ? all.filter((s) => s.id === category) : all;
  }, [menu, category]);

  const closed = menu?.branch.status !== 'ACTIVE';

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <BrandHeader
        title={theme.displayName ?? branchName}
        subtitle={theme.tagline ?? undefined}
        compact
        right={
          <Touchable
            onPress={() => navigation.navigate('Branches')}
            accessibilityLabel="Trocar de unidade"
          >
            <View style={styles.switchBranch}>
              <Text style={[styles.switchText, { color: theme.onPrimary }]}>Trocar</Text>
            </View>
          </Touchable>
        }
      />

      <SafeAreaView edges={['bottom']} style={styles.body}>
        <AsyncBoundary
          loading={loading}
          error={error}
          isEmpty={Boolean(menu) && sections.length === 0 && !category}
          onRetry={onRetry}
          empty={
            <EmptyState
              icon="📋"
              title="Cardápio em preparo"
              description="Esta unidade ainda não publicou os produtos."
            />
          }
          skeleton={
            <View style={{ padding: gutter }}>
              {[0, 1, 2].map((i) => (
                <ProductCardSkeleton key={i} imageHeight={cardImageHeight} />
              ))}
            </View>
          }
        >
          {menu ? (
            <>
              {closed ? (
                <View style={{ paddingHorizontal: gutter, paddingTop: spacing.md }}>
                  <Notice tone="warning" title="Loja fechada no momento">
                    Você pode ver o cardápio, mas não é possível finalizar o pedido agora.
                  </Notice>
                </View>
              ) : null}

              <SectionList
                ref={listRef}
                sections={sections}
                keyExtractor={(item) => item.id}
                stickySectionHeadersEnabled={false}
                contentContainerStyle={{
                  paddingHorizontal: gutter,
                  paddingBottom: spacing.xxxl * 2,
                }}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={theme.primary}
                  />
                }
                ListHeaderComponent={
                  <MenuHeader
                    menu={menu}
                    category={category}
                    onCategory={setCategory}
                    onProduct={(id) => navigation.navigate('Product', { productId: id, menu })}
                    imageHeight={cardImageHeight}
                  />
                }
                renderSectionHeader={({ section }) => (
                  <SectionHeader title={section.title} count={section.data.length} />
                )}
                renderItem={({ item, index }) => (
                  <FadeIn delay={Math.min(index, 6) * 30}>
                    <ProductCard
                      product={item}
                      imageHeight={cardImageHeight}
                      featured={item.isFeatured}
                      onPress={() => navigation.navigate('Product', { productId: item.id, menu })}
                      onAdd={
                        // Item COM adicionais precisa de escolha: abrir a
                        // página é o certo. Item simples entra direto — um
                        // toque, sem tela intermediária.
                        item.allowsCustomerNotes
                          ? () => navigation.navigate('Product', { productId: item.id, menu })
                          : () =>
                              cart.add({
                                product: item,
                                branchId: menu.branch.id,
                                organizationSlug: ORGANIZATION_SLUG,
                                branchSlug: menu.branch.slug,
                                quantity: 1,
                                selectedOptions: [],
                              })
                      }
                    />
                  </FadeIn>
                )}
                ListEmptyComponent={
                  <EmptyState
                    icon="🔍"
                    title="Nada nesta categoria"
                    description="Escolha outra categoria para continuar."
                    action={{ label: 'Ver tudo', onPress: () => setCategory(null) }}
                  />
                }
              />

              {cart.count > 0 && !closed ? (
                <StickyBar>
                  <View style={styles.cartSummary}>
                    <View>
                      <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
                        {cart.count} {cart.count === 1 ? 'item' : 'itens'}
                      </Text>
                      <Price cents={cart.totals()?.subtotalCents ?? 0} size="lg" />
                    </View>
                    <View style={styles.cartButton}>
                      <Button
                        label="Ver carrinho"
                        icon="🛒"
                        onPress={() => navigation.navigate('Cart', { menu })}
                      />
                    </View>
                  </View>
                </StickyBar>
              ) : null}
            </>
          ) : null}
        </AsyncBoundary>
      </SafeAreaView>
    </View>
  );
}

/** Cabeçalho rolável: categorias e vitrine de destaques. */
function MenuHeader({
  menu,
  category,
  onCategory,
  onProduct,
  imageHeight,
}: {
  menu: Menu;
  category: string | null;
  onCategory: (next: string | null) => void;
  onProduct: (productId: string) => void;
  imageHeight: number;
}) {
  const theme = useTheme();
  const categories = menu.categories.filter((c) => c.products.length > 0);

  return (
    <View>
      {categories.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          // O filtro de categoria fica ANTES dos destaques porque é o controle
          // que o cliente procura primeiro quando já sabe o que quer.
        >
          <Chip label="Tudo" selected={category === null} onPress={() => onCategory(null)} />
          {categories.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              count={c.products.length}
              selected={category === c.id}
              onPress={() => onCategory(c.id)}
            />
          ))}
        </ScrollView>
      ) : null}

      {menu.featured.length > 0 && category === null ? (
        <View>
          <SectionHeader title="Destaques" />
          <FlatList
            horizontal
            data={menu.featured}
            keyExtractor={(item) => item.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.featuredList}
            renderItem={({ item }) => (
              <View style={styles.featuredCard}>
                <ProductCard
                  product={item}
                  featured
                  imageHeight={Math.round(imageHeight * 0.8)}
                  onPress={() => onProduct(item.id)}
                />
              </View>
            )}
          />
        </View>
      ) : null}

      {menu.settings && menu.settings.minOrderCents > 0 ? (
        <Text style={[theme.font('caption'), { color: theme.mutedText, paddingTop: spacing.sm }]}>
          Pedido mínimo de {formatBRL(menu.settings.minOrderCents)} · preparo em cerca de{' '}
          {menu.settings.preparationTimeMinutes} min
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1 },
  switchBranch: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: '#ffffff2e',
    minHeight: 36,
    justifyContent: 'center',
  },
  switchText: { fontWeight: '700', fontSize: 13 },
  chips: { gap: spacing.sm, paddingVertical: spacing.md },
  featuredList: { gap: spacing.md, paddingBottom: spacing.sm },
  featuredCard: { width: 240 },
  cartSummary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  cartButton: { flex: 1, maxWidth: 200 },
});
