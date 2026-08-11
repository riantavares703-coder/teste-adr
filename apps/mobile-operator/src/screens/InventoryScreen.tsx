import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { InventoryRow } from '@plataforma/client';
import {
  AsyncBoundary,
  Badge,
  Card,
  EmptyState,
  Field,
  Touchable,
  TOUCH_TARGET,
  friendlyMessage,
  radius,
  semantic,
  spacing,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import { useBranch } from '../branch-context.js';

/**
 * ESTOQUE VIRTUAL — item 3 do Prompt 02.
 *
 * ESGOTAR / REATIVAR / +1 / +5 / +10, como no briefing. Cada toque chama o
 * servidor imediatamente: não existe "salvar" no fim. O botão fica ocupado
 * durante a chamada para que um segundo toque não dispare dois ajustes.
 *
 * O que este ecrã NUNCA faz é calcular disponibilidade sozinho — o campo
 * `availability` vem pronto do servidor a cada carregamento, e é ele que
 * decide se o produto aparece como esgotado no cardápio do cliente.
 */
export function InventoryScreen() {
  const theme = useTheme();
  const { gutter } = useResponsive();
  const { api, signOut } = useSession();
  const branch = useBranch();

  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ productId: string; message: string } | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!branch.branchId) return;
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        setRows(await api.listInventory(branch.branchId));
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api, branch.branchId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function run(productId: string, action: () => Promise<InventoryRow>) {
    setBusyProductId(productId);
    setRowError(null);
    try {
      const updated = await action();
      setRows((current) => current.map((r) => (r.productId === productId ? updated : r)));
    } catch (e) {
      setRowError({ productId, message: friendlyMessage(e) });
    } finally {
      setBusyProductId(null);
    }
  }

  const filtered = query.trim()
    ? rows.filter((r) => r.productName.toLowerCase().includes(query.trim().toLowerCase()))
    : rows;

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <AsyncBoundary
        loading={loading || branch.loading}
        error={error}
        onRetry={() => void load()}
        onSessionExpired={() => void signOut()}
      >
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.productId}
          contentContainerStyle={{ padding: gutter, gap: spacing.md, paddingBottom: spacing.xxxl }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} tintColor={theme.primary} />
          }
          ListHeaderComponent={
            <View style={{ paddingBottom: spacing.sm }}>
              <Field label="Buscar produto" placeholder="Nome do produto…" value={query} onChangeText={setQuery} />
            </View>
          }
          ListEmptyComponent={
            <EmptyState icon="📦" title="Nenhum produto encontrado" description="Ajuste a busca ou cadastre um produto no cardápio." />
          }
          renderItem={({ item }) => (
            <InventoryRowCard
              row={item}
              busy={busyProductId === item.productId}
              error={rowError?.productId === item.productId ? rowError.message : null}
              onSoldOut={() =>
                branch.branchId &&
                run(item.productId, () => api.markSoldOut(branch.branchId!, item.productId))
              }
              onReactivate={() =>
                branch.branchId &&
                run(item.productId, () => api.reactivate(branch.branchId!, item.productId))
              }
              onAdjust={(delta) =>
                branch.branchId &&
                run(item.productId, () => api.adjustStock(branch.branchId!, item.productId, delta))
              }
            />
          )}
        />
      </AsyncBoundary>
    </View>
  );
}

function InventoryRowCard({
  row,
  busy,
  error,
  onSoldOut,
  onReactivate,
  onAdjust,
}: {
  row: InventoryRow;
  busy: boolean;
  error: string | null;
  onSoldOut: () => void;
  onReactivate: () => void;
  onAdjust: (delta: number) => void;
}) {
  const theme = useTheme();
  const available = row.availability.isPurchasable;

  return (
    <Card>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text numberOfLines={1} style={theme.font('subheading')}>
            {row.productName}
          </Text>
          <Text style={[theme.font('caption'), { color: theme.mutedText }]}>
            {row.mode === 'INFINITE'
              ? 'Sem controle de quantidade'
              : `${Math.max(0, row.onHandQty - row.reservedQty)} disponível de ${row.onHandQty}`}
          </Text>
        </View>
        <Badge
          tone={
            available
              ? { fg: semantic.success, bg: semantic.successBg }
              : { fg: semantic.danger, bg: semantic.dangerBg }
          }
          label={available ? 'Disponível' : 'Esgotado'}
        />
      </View>

      <View style={styles.actions}>
        <QuickAction label="ESGOTAR" tone="danger" disabled={busy || !available} onPress={onSoldOut} />
        <QuickAction label="REATIVAR" tone="success" disabled={busy || available} onPress={onReactivate} />
      </View>

      {row.mode === 'LIMITED' ? (
        <View style={styles.actions}>
          <QuickAction label="+1" disabled={busy} onPress={() => onAdjust(1)} />
          <QuickAction label="+5" disabled={busy} onPress={() => onAdjust(5)} />
          <QuickAction label="+10" disabled={busy} onPress={() => onAdjust(10)} />
        </View>
      ) : null}

      {error ? (
        <Text style={[theme.font('caption'), { color: semantic.danger }]}>{error}</Text>
      ) : null}
    </Card>
  );
}

function QuickAction({
  label,
  tone,
  disabled,
  onPress,
}: {
  label: string;
  tone?: 'danger' | 'success';
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const colors =
    tone === 'danger'
      ? { bg: semantic.dangerBg, fg: semantic.danger }
      : tone === 'success'
        ? { bg: semantic.successBg, fg: semantic.success }
        : { bg: theme.subtle, fg: theme.text };

  return (
    <Touchable onPress={onPress} disabled={disabled} accessibilityLabel={label} scaleTo={0.94}>
      <View
        style={[
          styles.quickAction,
          { backgroundColor: colors.bg, opacity: disabled ? 0.4 : 1 },
        ]}
      >
        <Text style={[styles.quickActionLabel, { color: colors.fg }]}>{label}</Text>
      </View>
    </Touchable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingBottom: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm, flexWrap: 'wrap' },
  quickAction: {
    minHeight: TOUCH_TARGET - 6,
    minWidth: 64,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  quickActionLabel: { fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
});
