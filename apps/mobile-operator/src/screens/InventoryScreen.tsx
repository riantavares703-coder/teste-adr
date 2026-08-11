import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { InventoryRow } from '@plataforma/client';
import { AVAILABILITY_LABEL } from '@plataforma/domain';
import {
  Badge,
  Button,
  ErrorState,
  Loading,
  palette,
  radius,
  spacing,
  typography,
} from '@plataforma/ui';
import { useSession } from '../session.js';

/**
 * Painel de ESTOQUE VIRTUAL (item 3 do Prompt 02).
 *
 *   Produto | Disponível | Status
 *   [ ESGOTAR ] [ REATIVAR ] [ +1 ] [ +5 ] [ +10 ]
 *
 * "Disponível" é `on_hand − reserved`: unidades já presas em pedidos abertos
 * não aparecem como vendáveis. Todas as ações são auditadas com autor e horário.
 */
export function InventoryScreen() {
  const { api, profile } = useSession();
  const branchId = profile?.branchScope[0] ?? null;

  const [rows, setRows] = useState<InventoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const canAdjust = profile?.permissions.includes('inventory:adjust') ?? false;
  const canSoldOut = profile?.permissions.includes('inventory:mark_sold_out') ?? false;

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      setError(null);
      setRows(await api.listInventory(branchId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(productId: string, action: () => Promise<unknown>) {
    setBusy(productId);
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!branchId) return <ErrorState message="Seu usuário não tem unidade associada." />;
  if (error && !rows) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!rows) return <Loading label="Carregando estoque…" />;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <View style={styles.tableHeader}>
        <Text style={[styles.headerCell, styles.colProduct]}>PRODUTO</Text>
        <Text style={[styles.headerCell, styles.colQty]}>DISPONÍVEL</Text>
        <Text style={[styles.headerCell, styles.colStatus]}>STATUS</Text>
      </View>

      {error ? <Text style={styles.errorBanner}>{error}</Text> : null}

      {rows.map((row) => {
        const status = row.availability.status;
        const tone =
          status === 'AVAILABLE'
            ? { fg: palette.success, bg: palette.successBg }
            : { fg: palette.danger, bg: palette.dangerBg };
        const isBusy = busy === row.productId;

        return (
          <View key={row.productId} style={styles.row}>
            <View style={styles.rowTop}>
              <Text style={[typography.body, styles.colProduct]} numberOfLines={1}>
                {row.productName}
              </Text>
              <Text style={[styles.quantity, styles.colQty]}>
                {row.availability.availableQuantity === null
                  ? '∞'
                  : row.availability.availableQuantity}
              </Text>
              <View style={styles.colStatus}>
                <Badge label={AVAILABILITY_LABEL[status]} fg={tone.fg} bg={tone.bg} />
              </View>
            </View>

            {row.mode === 'LIMITED' && row.reservedQty > 0 ? (
              <Text style={typography.caption}>
                {row.onHandQty} em estoque · {row.reservedQty} reservado(s) em pedidos abertos
              </Text>
            ) : null}

            <View style={styles.actions}>
              {canSoldOut ? (
                row.isManuallySoldOut ? (
                  <Button
                    label="REATIVAR"
                    variant="secondary"
                    loading={isBusy}
                    onPress={() => void run(row.productId, () => api.reactivate(branchId, row.productId))}
                    style={styles.actionWide}
                  />
                ) : (
                  <Button
                    label="ESGOTAR"
                    variant="danger"
                    loading={isBusy}
                    onPress={() =>
                      void run(row.productId, () => api.markSoldOut(branchId, row.productId))
                    }
                    style={styles.actionWide}
                  />
                )
              ) : null}

              {canAdjust
                ? [1, 5, 10].map((delta) => (
                    <Button
                      key={delta}
                      label={`+${delta}`}
                      variant="secondary"
                      loading={isBusy}
                      onPress={() =>
                        void run(row.productId, () => api.adjustStock(branchId, row.productId, delta))
                      }
                      style={styles.actionSmall}
                    />
                  ))
                : null}
            </View>
          </View>
        );
      })}

      {rows.length === 0 ? (
        <Text style={typography.caption}>Nenhum produto cadastrado nesta unidade.</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.ink100 },
  content: { padding: spacing.lg, gap: spacing.md },
  tableHeader: { flexDirection: 'row', paddingHorizontal: spacing.md },
  headerCell: { fontSize: 11, fontWeight: '800', color: palette.ink500, letterSpacing: 0.5 },
  colProduct: { flex: 3 },
  colQty: { flex: 1, textAlign: 'center' },
  colStatus: { flex: 1.4, alignItems: 'flex-end' },
  errorBanner: { backgroundColor: palette.dangerBg, color: palette.danger, padding: spacing.md },
  row: {
    backgroundColor: palette.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center' },
  quantity: { fontSize: 20, fontWeight: '800', color: palette.ink900 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  actionWide: { flex: 2 },
  actionSmall: { flex: 1, paddingHorizontal: 0 },
});
