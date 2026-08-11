import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import type { BranchSummary } from '@plataforma/client';
import {
  AsyncBoundary,
  Badge,
  BrandHeader,
  Card,
  EmptyState,
  Touchable,
  semantic,
  spacing,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import type { ScreenProps } from '../navigation.js';

/**
 * ESCOLHER UNIDADE — primeira parada do fluxo do item 6.
 *
 * A franquia vem da configuração do build (`extra.organizationSlug`), não de
 * digitação do cliente: cada marca publica o próprio app, e ninguém deveria
 * precisar saber o "slug" de nada.
 *
 * Unidade fechada ou pausada aparece, com o estado visível, mas não é tocável.
 * Esconder seria pior: o cliente que conhece aquela loja acharia que o app
 * está com defeito.
 */
export function BranchesScreen({ navigation }: ScreenProps<'Branches'>) {
  const { api } = useSession();
  const theme = useTheme();
  const { gutter } = useResponsive();

  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const organizationSlug =
    (Constants.expoConfig?.extra as { organizationSlug?: string } | undefined)?.organizationSlug ??
    'acme';

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const list = await api.listBranches(organizationSlug);
        setBranches(list);
        // Franquia de uma unidade só: pular a escolha é o comportamento certo —
        // uma tela com um item só existe para ser dispensada.
        if (list.length === 1 && list[0].status === 'ACTIVE' && mode === 'initial') {
          navigation.replace('Menu', { branch: list[0] });
        }
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api, navigation, organizationSlug],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <BrandHeader
        title={theme.displayName ?? 'Escolha a unidade'}
        subtitle="Onde você quer pedir hoje?"
      />
      <SafeAreaView edges={['bottom']} style={styles.body}>
        <AsyncBoundary
          loading={loading}
          error={error}
          isEmpty={branches.length === 0}
          onRetry={() => void load()}
          loadingLabel="Buscando unidades…"
          empty={
            <EmptyState
              icon="📍"
              title="Nenhuma unidade disponível"
              description="Esta marca ainda não tem lojas abertas no aplicativo."
            />
          }
        >
          <FlatList
            data={branches}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: gutter, gap: spacing.md }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void load('refresh')}
                tintColor={theme.primary}
              />
            }
            renderItem={({ item }) => (
              <BranchCard
                branch={item}
                onPress={() => navigation.navigate('Menu', { branch: item })}
              />
            )}
          />
        </AsyncBoundary>
      </SafeAreaView>
    </View>
  );
}

function BranchCard({ branch, onPress }: { branch: BranchSummary; onPress: () => void }) {
  const theme = useTheme();
  const open = branch.status === 'ACTIVE';

  const address = [branch.street, branch.streetNumber].filter(Boolean).join(', ');
  const location = [branch.district, branch.city].filter(Boolean).join(' · ');

  const fulfillment = [
    branch.acceptsDelivery ? 'Entrega' : null,
    branch.acceptsPickup ? 'Retirada' : null,
  ].filter(Boolean);

  return (
    <Touchable
      onPress={onPress}
      disabled={!open}
      accessibilityLabel={`${branch.name}${open ? '' : ', fechada no momento'}`}
      accessibilityHint={open ? 'Abre o cardápio desta unidade' : undefined}
    >
      <Card style={!open ? styles.closed : undefined}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitle}>
            <Text style={theme.font('subheading')}>{branch.name}</Text>
            {address ? (
              <Text style={[theme.font('caption'), { color: theme.mutedText }]}>{address}</Text>
            ) : null}
            {location ? (
              <Text style={[theme.font('caption'), { color: theme.mutedText }]}>{location}</Text>
            ) : null}
          </View>
          {open ? (
            <Badge tone={{ fg: semantic.success, bg: semantic.successBg }} label="Aberta" small />
          ) : (
            <Badge tone={{ fg: semantic.neutral, bg: semantic.neutralBg }} label="Fechada" small />
          )}
        </View>

        {fulfillment.length > 0 ? (
          <View style={styles.tags}>
            {fulfillment.map((tag) => (
              <View key={tag} style={[styles.tag, { backgroundColor: theme.subtle }]}>
                <Text style={[theme.font('caption'), { color: theme.mutedText }]}>{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </Card>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1 },
  closed: { opacity: 0.55 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  cardTitle: { flex: 1, gap: 2 },
  tags: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.md },
  tag: { borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
});
