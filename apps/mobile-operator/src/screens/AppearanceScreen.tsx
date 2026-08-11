import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { BrandingSettings } from '@plataforma/client';
import {
  BRAND_FONTS,
  GRADIENT_STYLES,
  contrastIssues,
  validateBranding,
  type BrandingInput,
} from '@plataforma/domain';
import {
  AsyncBoundary,
  Badge,
  BrandHeader,
  Button,
  Card,
  Chip,
  Field,
  Notice,
  Price,
  ProductCard,
  QuantityStepper,
  Row,
  SectionHeader,
  ThemeProvider,
  Touchable,
  buildTheme,
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
 * EDITOR DE APARÊNCIA — itens 1 a 4.
 *
 * A regra de design deste ecrã: NENHUM controle aceita texto livre que vire
 * estilo. Cor é um seletor de swatches (mais um campo hex, sempre validado);
 * fonte e gradiente são listas fechadas. É a mesma disciplina do backend
 * (`.strict()` + enum), espelhada na interface — o usuário nunca vê um campo
 * que o servidor recusaria.
 *
 * O preview (item 4) é a MESMA árvore de componentes do app real, dentro de
 * um `ThemeProvider` isolado com o rascunho atual. Não é uma imagem estática:
 * é `<ProductCard>`, `<Button>`, `<Card>` de verdade, então o que o lojista vê
 * aqui é exatamente o que o cliente vê ao publicar.
 */
const SWATCHES = [
  '#e11d48', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#111827', '#374151',
];

const PREVIEW_PRODUCT = {
  id: 'preview',
  name: 'X-Burger Artesanal',
  description: 'Pão brioche, blend 160g, queijo e molho da casa',
  priceCents: 2990,
  thumbUrl: null,
  imageUrl: null,
  availability: { status: 'AVAILABLE' as const, isPurchasable: true, availableQuantity: null },
};

export function AppearanceScreen() {
  const theme = useTheme();
  const { gutter, isTablet } = useResponsive();
  const { api } = useSession();
  const branch = useBranch();

  const [current, setCurrent] = useState<BrandingSettings | null>(null);
  const [draft, setDraft] = useState<BrandingInput>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!branch.branchId) return;
    setLoading(true);
    setError(null);
    try {
      const settings = await api.getBranding(branch.branchId);
      setCurrent(settings);
      setDraft(settings);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, branch.branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const { value: normalized, issues } = useMemo(() => validateBranding(draft), [draft]);
  const previewTheme = useMemo(() => buildTheme(normalized), [normalized]);
  const dirty = current ? JSON.stringify(draft) !== JSON.stringify(current) : false;

  function set<K extends keyof BrandingInput>(key: K, value: BrandingInput[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  }

  async function save() {
    if (!branch.branchId || issues.length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateBranding(branch.branchId, normalized);
      setCurrent(updated);
      setDraft(updated);
      setSaved(true);
      await branch.reloadBranding();
    } catch (e) {
      setSaveError(friendlyMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <AsyncBoundary loading={loading} error={error} onRetry={() => void load()}>
        <ScrollView contentContainerStyle={{ padding: gutter, gap: spacing.lg, paddingBottom: spacing.xxxl }}>
          <View style={isTablet ? styles.splitRow : undefined}>
            <View style={isTablet ? styles.splitForm : undefined}>
              <SectionHeader title="Estabelecimento" />
              <Card>
                <View style={{ gap: spacing.md }}>
                  <Field
                    label="Nome exibido"
                    placeholder="Ex.: Burger do Centro"
                    value={draft.displayName ?? ''}
                    onChangeText={(v) => set('displayName', v)}
                    maxLength={60}
                  />
                  <Field
                    label="Frase de apoio (opcional)"
                    placeholder="Ex.: Artesanal desde 2019"
                    value={draft.tagline ?? ''}
                    onChangeText={(v) => set('tagline', v)}
                    maxLength={120}
                  />
                </View>
              </Card>

              <SectionHeader title="Cores" />
              <Card>
                <View style={{ gap: spacing.lg }}>
                  <ColorField
                    label="Cor principal"
                    value={draft.primaryColor}
                    onChange={(v) => set('primaryColor', v)}
                  />
                  <ColorField
                    label="Cor secundária"
                    value={draft.secondaryColor}
                    onChange={(v) => set('secondaryColor', v)}
                  />
                  <ColorField
                    label="Cor de destaque"
                    value={draft.accentColor}
                    onChange={(v) => set('accentColor', v)}
                  />
                  <ColorField
                    label="Cor do texto"
                    value={draft.textColor}
                    onChange={(v) => set('textColor', v)}
                  />
                  <ColorField
                    label="Cor do fundo"
                    value={draft.backgroundColor}
                    onChange={(v) => set('backgroundColor', v)}
                  />
                  <ColorField
                    label="Cor dos cards"
                    value={draft.cardColor}
                    onChange={(v) => set('cardColor', v)}
                  />
                </View>
              </Card>

              <SectionHeader title="Gradiente do cabeçalho" />
              <Card>
                <View style={styles.chips}>
                  {GRADIENT_STYLES.map((g) => (
                    <Chip
                      key={g.token}
                      label={g.label}
                      selected={(draft.gradientStyle ?? 'DIAGONAL') === g.token}
                      onPress={() => set('gradientStyle', g.token)}
                    />
                  ))}
                </View>
                {(draft.gradientStyle ?? 'DIAGONAL') !== 'NONE' ? (
                  <View style={{ gap: spacing.lg, paddingTop: spacing.md }}>
                    <ColorField
                      label="Gradiente — início"
                      value={draft.gradientFrom}
                      onChange={(v) => set('gradientFrom', v)}
                    />
                    <ColorField
                      label="Gradiente — fim"
                      value={draft.gradientTo}
                      onChange={(v) => set('gradientTo', v)}
                    />
                  </View>
                ) : null}
              </Card>

              <SectionHeader title="Tipografia" />
              <Card>
                <Text style={[theme.font('caption'), { color: theme.mutedText, paddingBottom: spacing.sm }]}>
                  Lista fixa — não é possível carregar fonte externa nem CSS.
                </Text>
                <View style={styles.chips}>
                  {BRAND_FONTS.map((f) => (
                    <Chip
                      key={f.token}
                      label={f.label}
                      selected={(draft.fontToken ?? 'INTER') === f.token}
                      onPress={() => set('fontToken', f.token)}
                    />
                  ))}
                </View>
              </Card>

              {issues.length > 0 ? (
                <Notice tone="warning" title="Revise antes de publicar">
                  {issues.map((p) => p.message).join(' ')}
                </Notice>
              ) : null}

              {saveError ? <Notice tone="danger">{saveError}</Notice> : null}
              {saved && !dirty ? <Notice tone="success">Identidade visual publicada.</Notice> : null}

              <Button
                label={dirty ? 'Publicar alterações' : 'Nada para publicar'}
                loading={saving}
                disabled={!dirty || issues.length > 0}
                onPress={() => void save()}
              />
            </View>

            <View style={isTablet ? styles.splitPreview : { paddingTop: spacing.xl }}>
              <SectionHeader title="Pré-visualização" />
              <Text style={[theme.font('caption'), { color: theme.mutedText, paddingBottom: spacing.md }]}>
                Atualiza a cada alteração — é assim que o cliente vai ver.
              </Text>
              <LivePreview theme={previewTheme} />
            </View>
          </View>
        </ScrollView>
      </AsyncBoundary>
    </View>
  );
}

/** Campo de cor: swatches rápidos + hex, sempre validado e nunca livre. */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (next: string) => void;
}) {
  const theme = useTheme();
  const [text, setText] = useState(value ?? '');

  useEffect(() => setText(value ?? ''), [value]);

  const valid = /^#[0-9a-fA-F]{6}$/.test(text);

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={styles.colorHeader}>
        <View style={[styles.swatchPreview, { backgroundColor: valid ? text : theme.subtle }]} />
        <Text style={theme.font('subheading')}>{label}</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatchRow}>
        {SWATCHES.map((swatch) => (
          <Touchable
            key={swatch}
            onPress={() => {
              setText(swatch);
              onChange(swatch);
            }}
            accessibilityLabel={`Usar a cor ${swatch}`}
            accessibilityState={{ selected: swatch === text.toLowerCase() }}
            scaleTo={0.9}
          >
            <View
              style={[
                styles.swatch,
                { backgroundColor: swatch, borderColor: swatch === text.toLowerCase() ? theme.text : 'transparent' },
              ]}
            />
          </Touchable>
        ))}
      </ScrollView>

      <TextInput
        accessibilityLabel={`${label} (código hexadecimal)`}
        value={text}
        onChangeText={(next) => {
          setText(next);
          // Só propaga quando é uma cor de verdade — dígito a dígito o campo
          // fica INVÁLIDO por natureza, e propagar isso quebraria o preview a
          // cada tecla.
          if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next);
        }}
        placeholder="#RRGGBB"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={7}
        style={[
          styles.hexInput,
          { borderColor: valid ? theme.border : semantic.danger, color: theme.text, backgroundColor: theme.card },
        ]}
      />
    </View>
  );
}

/**
 * O preview em si.
 *
 * Envolvido no próprio `ThemeProvider`, INDEPENDENTE do tema real da tela —
 * dois temas coexistindo na mesma árvore, sem estado global. É essa
 * independência que garante que o rascunho não vaza para o resto do painel
 * antes de ser publicado.
 */
function LivePreview({ theme }: { theme: ReturnType<typeof buildTheme> }) {
  return (
    <ThemeProvider value={theme}>
      <View style={[styles.previewFrame, { backgroundColor: theme.background, borderColor: theme.border }]}>
        <BrandHeader
          title={theme.displayName ?? 'Sua Loja'}
          subtitle={theme.tagline ?? 'assim ficará o cabeçalho'}
          compact
        />
        <View style={{ padding: spacing.md, gap: spacing.md }}>
          <View style={styles.previewGrid}>
            <View style={styles.previewCard}>
              <ProductCard product={PREVIEW_PRODUCT} imageHeight={110} />
            </View>
          </View>

          <Card>
            <Row label="Subtotal" value="R$ 29,90" />
            <Row label="Entrega" value="R$ 6,00" />
            <Row label="Total" value="R$ 35,90" strong />
          </Card>

          <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
            <QuantityStepper value={2} onChange={() => undefined} compact />
            <Badge tone={{ fg: theme.onAccent, bg: theme.accent }} label="Destaque" small />
          </View>

          <Button label="Finalizar pedido" onPress={() => undefined} />
          <Button label="Cancelar" variant="ghost" onPress={() => undefined} />

          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Price cents={2990} />
            <Price cents={3990} strikethrough color={theme.mutedText} />
          </View>
        </View>
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  splitRow: { flexDirection: 'row', gap: spacing.xl },
  splitForm: { flex: 1 },
  splitPreview: { flex: 1, position: 'relative', top: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  colorHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  swatchPreview: { width: 24, height: 24, borderRadius: radius.sm },
  swatchRow: { gap: spacing.sm, paddingVertical: spacing.xs },
  swatch: { width: 32, height: 32, borderRadius: radius.pill, borderWidth: 3 },
  hexInput: {
    borderWidth: 1.5,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    maxWidth: 140,
  },
  previewFrame: {
    borderWidth: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  previewGrid: { flexDirection: 'row' },
  previewCard: { flex: 1, maxWidth: 220 },
});
