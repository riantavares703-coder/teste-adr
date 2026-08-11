import React from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { formatBRL, type AvailabilityView } from '@plataforma/domain';
import { FadeIn, ProgressBar, Touchable } from './motion.js';
import {
  TOUCH_TARGET,
  elevation,
  radius,
  semantic,
  spacing,
  useTheme,
  type StatusTone,
} from './theme.js';

/**
 * BIBLIOTECA DE COMPONENTES.
 *
 * Todo componente aqui lê a marca de `useTheme()`. Nenhum importa cor
 * diretamente, com uma exceção deliberada: as cores SEMÂNTICAS (sucesso, erro,
 * alerta), que não são personalizáveis porque "cancelado" precisa parecer
 * cancelado em qualquer franquia.
 *
 * Todo elemento tocável tem no mínimo 44pt e rótulo de acessibilidade — não
 * como enfeite de conformidade, mas porque operador usa isto com a mão
 * ocupada e o cliente às vezes com uma mão só.
 */

// ---------------------------------------------------------------------------
// Botão
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  icon,
  fullWidth = true,
  style,
  accessibilityHint,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
  testID?: string;
}) {
  const theme = useTheme();
  const isDisabled = Boolean(disabled || loading);

  const palette: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
    primary: { bg: theme.primary, fg: theme.onPrimary },
    secondary: { bg: theme.subtle, fg: theme.text },
    ghost: { bg: 'transparent', fg: theme.text, border: theme.border },
    danger: { bg: semantic.danger, fg: '#ffffff' },
    success: { bg: semantic.success, fg: '#ffffff' },
  };
  const colors = palette[variant];

  const height = size === 'lg' ? 56 : size === 'sm' ? TOUCH_TARGET : 50;
  const fontSize = size === 'lg' ? 17 : size === 'sm' ? 14 : 16;

  return (
    <Touchable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: Boolean(loading) }}
      style={[fullWidth ? styles.fullWidth : undefined, style]}
    >
      <View
        style={[
          styles.button,
          {
            height,
            backgroundColor: colors.bg,
            borderColor: colors.border ?? 'transparent',
            borderWidth: colors.border ? 1 : 0,
            opacity: isDisabled ? 0.45 : 1,
          },
          variant === 'primary' && !isDisabled ? elevation.sm : null,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={colors.fg} />
        ) : (
          <Text
            numberOfLines={1}
            style={[
              styles.buttonLabel,
              { color: colors.fg, fontSize },
              theme.fontFamily ? { fontFamily: theme.fontFamily } : null,
            ]}
          >
            {icon ? `${icon}  ` : ''}
            {label}
          </Text>
        )}
      </View>
    </Touchable>
  );
}

// ---------------------------------------------------------------------------
// Superfícies
// ---------------------------------------------------------------------------

export function Card({
  children,
  onPress,
  style,
  padded = true,
  accessibilityLabel,
  accessibilityHint,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const theme = useTheme();
  const content = (
    <View
      style={[
        styles.card,
        elevation.sm,
        { backgroundColor: theme.card, padding: padded ? spacing.lg : 0 },
        style,
      ]}
    >
      {children}
    </View>
  );

  return onPress ? (
    <Touchable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      {content}
    </Touchable>
  ) : (
    content
  );
}

/**
 * Cabeçalho com a marca.
 *
 * Este é o componente que mais carrega a identidade: gradiente (ou cor sólida,
 * quando o estilo é NONE), logo e nome. As duas variações usam o MESMO
 * `LinearGradient` — com gradiente desligado, as duas paradas são iguais, o que
 * evita dois caminhos de código para o mesmo desenho.
 */
export function BrandHeader({
  title,
  subtitle,
  right,
  children,
  compact,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  const theme = useTheme();
  const onGradient = theme.gradient.enabled ? theme.onPrimary : theme.onPrimary;

  return (
    <LinearGradient
      colors={theme.gradient.colors as readonly [string, string]}
      start={theme.gradient.start}
      end={theme.gradient.end}
      style={[styles.brandHeader, compact ? styles.brandHeaderCompact : null]}
    >
      <View style={styles.brandRow}>
        {theme.logoUrl ? (
          <Image
            source={{ uri: theme.logoUrl }}
            style={styles.brandLogo}
            accessibilityIgnoresInvertColors
            accessible
            accessibilityLabel={`Logotipo de ${title ?? theme.displayName ?? 'estabelecimento'}`}
          />
        ) : null}
        <View style={styles.brandText}>
          {title ? (
            <Text numberOfLines={1} style={[styles.brandTitle, { color: onGradient }]}>
              {title}
            </Text>
          ) : null}
          {subtitle ? (
            <Text numberOfLines={1} style={[styles.brandSubtitle, { color: onGradient }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
      {children}
    </LinearGradient>
  );
}

export function SectionHeader({
  title,
  action,
  count,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
  count?: number;
}) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleRow}>
        <Text style={theme.font('heading')}>{title}</Text>
        {count !== undefined ? (
          <View style={[styles.countPill, { backgroundColor: theme.primarySoft }]}>
            <Text style={[styles.countPillText, { color: theme.primary }]}>{count}</Text>
          </View>
        ) : null}
      </View>
      {action ? (
        <Touchable onPress={action.onPress} accessibilityLabel={action.label}>
          <Text style={[theme.font('caption'), { color: theme.primary, fontWeight: '700' }]}>
            {action.label}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sinalização
// ---------------------------------------------------------------------------

export function Badge({
  tone,
  label,
  small,
}: {
  tone: StatusTone | { fg: string; bg: string };
  label?: string;
  small?: boolean;
}) {
  const text = label ?? (tone as StatusTone).label ?? '';
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: tone.bg, paddingVertical: small ? 3 : spacing.xs },
      ]}
    >
      <Text style={[styles.badgeLabel, { color: tone.fg, fontSize: small ? 10 : 11 }]}>
        {text.toUpperCase()}
      </Text>
    </View>
  );
}

export function Notice({
  tone = 'warning',
  title,
  children,
}: {
  tone?: 'warning' | 'info' | 'danger' | 'success';
  title?: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const map = {
    warning: { bg: semantic.warningBg, fg: semantic.warning, icon: '⚠️' },
    info: { bg: semantic.infoBg, fg: semantic.info, icon: 'ℹ️' },
    danger: { bg: semantic.dangerBg, fg: semantic.danger, icon: '⛔' },
    success: { bg: semantic.successBg, fg: semantic.success, icon: '✅' },
  }[tone];

  return (
    <View style={[styles.notice, { backgroundColor: map.bg }]}>
      <Text style={styles.noticeIcon}>{map.icon}</Text>
      <View style={styles.noticeBody}>
        {title ? (
          <Text style={[theme.font('subheading'), { color: map.fg }]}>{title}</Text>
        ) : null}
        <Text style={[theme.font('caption'), { color: map.fg }]}>{children}</Text>
      </View>
    </View>
  );
}

export function Price({
  cents,
  size = 'md',
  color,
  strikethrough,
}: {
  cents: number;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  color?: string;
  strikethrough?: boolean;
}) {
  const theme = useTheme();
  const fontSize = { sm: 14, md: 17, lg: 22, xl: 28 }[size];
  return (
    <Text
      accessibilityLabel={formatBRL(cents)}
      style={[
        {
          fontSize,
          fontWeight: '800',
          color: color ?? theme.text,
          letterSpacing: -0.4,
        },
        theme.fontFamily ? { fontFamily: theme.fontFamily } : null,
        strikethrough ? { textDecorationLine: 'line-through', opacity: 0.5 } : null,
      ]}
    >
      {formatBRL(cents)}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Cardápio
// ---------------------------------------------------------------------------

export interface ProductCardData {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  thumbUrl: string | null;
  imageUrl: string | null;
  availability: AvailabilityView;
}

/**
 * Card de produto do cardápio — o layout do item 5.
 *
 * O estado ESGOTADO não some com o produto nem o esconde atrás de um texto
 * pequeno: a foto é esmaecida e recebe um selo por cima, o botão de adicionar
 * desaparece e o card inteiro deixa de ser tocável. Um produto esgotado que
 * ainda parece clicável gera um erro no checkout que o cliente lê como falha
 * do app.
 */
export function ProductCard({
  product,
  onPress,
  onAdd,
  imageHeight = 170,
  featured,
}: {
  product: ProductCardData;
  onPress?: () => void;
  onAdd?: () => void;
  imageHeight?: number;
  featured?: boolean;
}) {
  const theme = useTheme();
  const available = product.availability.isPurchasable;
  const uri = product.thumbUrl ?? product.imageUrl;
  // "Últimas unidades" só faz sentido quando o produto CONTROLA quantidade;
  // em modo infinito, `availableQuantity` é null e o aviso não aparece.
  const remaining = product.availability.availableQuantity;
  const low = available && remaining !== null && remaining > 0 && remaining <= 5;

  return (
    <Card
      padded={false}
      onPress={available ? onPress : undefined}
      accessibilityLabel={`${product.name}, ${formatBRL(product.priceCents)}${
        available ? '' : ', esgotado'
      }`}
      accessibilityHint={available ? 'Abre os detalhes do produto' : undefined}
      style={styles.productCard}
    >
      <View style={{ height: imageHeight, backgroundColor: theme.subtle }}>
        {uri ? (
          <Image
            source={{ uri }}
            style={[styles.productImage, !available && styles.imageDimmed]}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={[styles.productImage, styles.imagePlaceholder]}>
            <Text style={styles.placeholderGlyph}>🍔</Text>
          </View>
        )}

        {!available ? (
          <View style={styles.soldOutOverlay}>
            <View style={styles.soldOutPill}>
              <Text style={styles.soldOutText}>ESGOTADO</Text>
            </View>
          </View>
        ) : null}

        {featured && available ? (
          <View style={[styles.featuredPill, { backgroundColor: theme.accent }]}>
            <Text style={[styles.featuredText, { color: theme.onAccent }]}>DESTAQUE</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.productBody}>
        <Text numberOfLines={1} style={theme.font('subheading')}>
          {product.name}
        </Text>
        {product.description ? (
          <Text numberOfLines={2} style={[theme.font('caption'), { color: theme.mutedText }]}>
            {product.description}
          </Text>
        ) : null}

        <View style={styles.productFooter}>
          <View style={styles.priceColumn}>
            <Price cents={product.priceCents} />
            {low ? (
              <Text style={[styles.lowStock, { color: semantic.warning }]}>
                Últimas {remaining} unidades
              </Text>
            ) : null}
          </View>

          {available && onAdd ? (
            <Touchable
              onPress={onAdd}
              accessibilityLabel={`Adicionar ${product.name} ao carrinho`}
              scaleTo={0.9}
            >
              <View style={[styles.addButton, { backgroundColor: theme.primary }]}>
                <Text style={[styles.addGlyph, { color: theme.onPrimary }]}>+</Text>
              </View>
            </Touchable>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/** Item horizontal compacto — usado na vitrine de destaques e no carrinho. */
export function ProductRow({
  title,
  subtitle,
  priceCents,
  imageUrl,
  right,
  onPress,
  dimmed,
}: {
  title: string;
  subtitle?: string | null;
  priceCents?: number;
  imageUrl?: string | null;
  right?: React.ReactNode;
  onPress?: () => void;
  dimmed?: boolean;
}) {
  const theme = useTheme();
  const body = (
    <View style={[styles.rowItem, dimmed && { opacity: 0.5 }]}>
      {imageUrl !== undefined ? (
        <View style={[styles.rowThumb, { backgroundColor: theme.subtle }]}>
          {imageUrl ? (
            <Image
              source={{ uri: imageUrl }}
              style={styles.rowThumbImage}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <Text style={styles.rowThumbGlyph}>🍔</Text>
          )}
        </View>
      ) : null}
      <View style={styles.rowItemBody}>
        <Text numberOfLines={1} style={theme.font('subheading')}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} style={[theme.font('caption'), { color: theme.mutedText }]}>
            {subtitle}
          </Text>
        ) : null}
        {priceCents !== undefined ? <Price cents={priceCents} size="sm" /> : null}
      </View>
      {right}
    </View>
  );

  return onPress ? (
    <Touchable onPress={onPress} accessibilityLabel={title}>
      {body}
    </Touchable>
  ) : (
    body
  );
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max,
  compact,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number | null;
  compact?: boolean;
}) {
  const theme = useTheme();
  const canDecrease = value > min;
  const canIncrease = max === null || max === undefined || value < max;
  const size = compact ? TOUCH_TARGET : 46;

  return (
    <View style={[styles.stepper, { borderColor: theme.border, backgroundColor: theme.card }]}>
      <Touchable
        onPress={() => onChange(value - 1)}
        disabled={!canDecrease}
        accessibilityLabel="Diminuir quantidade"
        scaleTo={0.88}
      >
        <View style={[styles.stepperButton, { width: size, height: size }, !canDecrease && styles.dim]}>
          <Text style={[styles.stepperGlyph, { color: theme.text }]}>−</Text>
        </View>
      </Touchable>

      <Text
        accessibilityLabel={`Quantidade: ${value}`}
        style={[styles.stepperValue, { color: theme.text }]}
      >
        {value}
      </Text>

      <Touchable
        onPress={() => onChange(value + 1)}
        disabled={!canIncrease}
        accessibilityLabel="Aumentar quantidade"
        scaleTo={0.88}
      >
        <View style={[styles.stepperButton, { width: size, height: size }, !canIncrease && styles.dim]}>
          <Text style={[styles.stepperGlyph, { color: theme.text }]}>+</Text>
        </View>
      </Touchable>
    </View>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string; icon?: string; disabled?: boolean }>;
  value: T;
  onChange: (next: T) => void;
  label?: string;
}) {
  const theme = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      <View style={[styles.segmented, { backgroundColor: theme.subtle }]}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Touchable
              key={option.value}
              onPress={() => onChange(option.value)}
              disabled={option.disabled}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ selected, disabled: option.disabled }}
              style={styles.segmentedItemWrapper}
              scaleTo={0.98}
            >
              <View
                style={[
                  styles.segmentedItem,
                  selected && { backgroundColor: theme.card, ...elevation.sm },
                  option.disabled && styles.dim,
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    theme.font('caption'),
                    {
                      fontWeight: selected ? '700' : '500',
                      color: selected ? theme.text : theme.mutedText,
                    },
                  ]}
                >
                  {option.icon ? `${option.icon} ` : ''}
                  {option.label}
                </Text>
              </View>
            </Touchable>
          );
        })}
      </View>
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  count,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  count?: number;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      scaleTo={0.95}
    >
      <View
        style={[
          styles.chip,
          {
            backgroundColor: selected ? theme.primary : theme.card,
            borderColor: selected ? theme.primary : theme.border,
          },
        ]}
      >
        <Text
          style={[
            styles.chipLabel,
            { color: selected ? theme.onPrimary : theme.text },
            theme.fontFamily ? { fontFamily: theme.fontFamily } : null,
          ]}
        >
          {label}
          {count !== undefined ? ` (${count})` : ''}
        </Text>
      </View>
    </Touchable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  error,
  keyboardType,
  secureTextEntry,
  autoCapitalize = 'sentences',
  autoComplete,
  multiline,
  maxLength,
  editable = true,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'number-pad';
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoComplete?: 'email' | 'tel' | 'current-password' | 'name' | 'off';
  multiline?: boolean;
  maxLength?: number;
  editable?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[theme.font('caption'), { color: theme.mutedText, fontWeight: '600' }]}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholder={placeholder}
        placeholderTextColor={theme.mutedText}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        autoCorrect={!secureTextEntry}
        multiline={multiline}
        maxLength={maxLength}
        editable={editable}
        style={[
          styles.input,
          {
            backgroundColor: editable ? theme.card : theme.subtle,
            borderColor: error ? semantic.danger : theme.border,
            color: theme.text,
            minHeight: multiline ? 92 : 52,
            textAlignVertical: multiline ? 'top' : 'center',
          },
          theme.fontFamily ? { fontFamily: theme.fontFamily } : null,
        ]}
      />
      {error ? (
        <Text style={[theme.font('caption'), { color: semantic.danger }]}>{error}</Text>
      ) : hint ? (
        <Text style={[theme.font('caption'), { color: theme.mutedText }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

/**
 * Cartão de indicador.
 *
 * O painel do operador (item 7) precisa ser lido de relance, de longe, com a
 * loja cheia. Por isso o NÚMERO é o elemento maior do card e o rótulo vem
 * abaixo, em vez do arranjo de dashboard corporativo (rótulo grande, número
 * pequeno, ícone decorativo disputando atenção).
 */
export function StatCard({
  value,
  label,
  tone,
  onPress,
  emphasis,
  hint,
}: {
  value: string | number;
  label: string;
  tone?: { fg: string; bg: string };
  onPress?: () => void;
  emphasis?: boolean;
  hint?: string;
}) {
  const theme = useTheme();
  const fg = tone?.fg ?? theme.text;
  const bg = tone?.bg ?? theme.card;

  return (
    <Touchable
      onPress={onPress}
      disabled={!onPress}
      accessibilityLabel={`${label}: ${value}`}
      accessibilityHint={hint}
      accessibilityRole={onPress ? 'button' : 'text'}
      style={styles.statWrapper}
      scaleTo={0.96}
    >
      <View
        style={[
          styles.statCard,
          elevation.sm,
          { backgroundColor: bg, borderColor: emphasis ? fg : 'transparent', borderWidth: emphasis ? 2 : 0 },
        ]}
      >
        <Text style={[styles.statValue, { color: fg }, theme.fontFamily ? { fontFamily: theme.fontFamily } : null]}>
          {value}
        </Text>
        <Text numberOfLines={2} style={[styles.statLabel, { color: fg }]}>
          {label}
        </Text>
      </View>
    </Touchable>
  );
}

/** Linha rótulo/valor — resumo de valores no carrinho e no pedido. */
export function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.summaryRow}>
      <Text style={[strong ? theme.font('subheading') : theme.font('body'), { color: tone ?? (strong ? theme.text : theme.mutedText) }]}>
        {label}
      </Text>
      <Text
        style={[
          strong ? theme.font('subheading') : theme.font('body'),
          { color: tone ?? theme.text, fontWeight: strong ? '800' : '500' },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * Linha do tempo do pedido.
 *
 * Substitui a lista de status por algo que responde à pergunta real do
 * cliente: "onde está meu pedido AGORA e o que falta". Passos já cumpridos,
 * passo atual destacado e futuros esmaecidos.
 */
export function Timeline({
  steps,
  currentIndex,
}: {
  steps: Array<{ label: string; at?: string | null }>;
  currentIndex: number;
}) {
  const theme = useTheme();
  const progress = steps.length > 1 ? currentIndex / (steps.length - 1) : 0;

  return (
    <View style={styles.timeline}>
      <ProgressBar value={progress} color={theme.primary} trackColor={theme.subtle} />
      <View style={styles.timelineSteps}>
        {steps.map((step, index) => {
          const done = index <= currentIndex;
          return (
            <View key={step.label} style={styles.timelineStep}>
              <View
                style={[
                  styles.timelineDot,
                  {
                    backgroundColor: done ? theme.primary : theme.subtle,
                    borderColor: index === currentIndex ? theme.primary : 'transparent',
                  },
                ]}
              />
              <Text
                numberOfLines={2}
                style={[
                  styles.timelineLabel,
                  {
                    color: done ? theme.text : theme.mutedText,
                    fontWeight: index === currentIndex ? '700' : '400',
                  },
                ]}
              >
                {step.label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sobreposições
// ---------------------------------------------------------------------------

/** Painel deslizante — evita empurrar o usuário para outra tela por uma escolha curta. */
export function Sheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Touchable onPress={onClose} accessibilityLabel="Fechar" style={styles.sheetDismiss}>
          <View style={styles.sheetDismissArea} />
        </Touchable>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={[styles.sheetHandle, { backgroundColor: theme.border }]} />
          <View style={styles.sheetHeader}>
            <Text style={theme.font('heading')}>{title}</Text>
            <Touchable onPress={onClose} accessibilityLabel="Fechar">
              <View style={[styles.sheetClose, { backgroundColor: theme.subtle }]}>
                <Text style={{ color: theme.text, fontSize: 18 }}>✕</Text>
              </View>
            </Touchable>
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody}>{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** Barra fixa no rodapé — total do carrinho, ação principal do checkout. */
export function StickyBar({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.stickyBar,
        elevation.lg,
        { backgroundColor: theme.card, borderTopColor: theme.border },
      ]}
    >
      {children}
    </View>
  );
}

export { FadeIn, Touchable, ProgressBar };

const styles = StyleSheet.create({
  fullWidth: { width: '100%' },
  button: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
  },
  buttonLabel: { fontWeight: '700', letterSpacing: -0.2 },

  card: { borderRadius: radius.lg, overflow: 'hidden' },

  brandHeader: {
    paddingTop: Platform.OS === 'ios' ? spacing.xxl + spacing.lg : spacing.xxl,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  brandHeaderCompact: { paddingTop: spacing.xl, paddingBottom: spacing.lg },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  brandLogo: { width: 48, height: 48, borderRadius: radius.md, backgroundColor: '#ffffff22' },
  brandText: { flex: 1 },
  brandTitle: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  brandSubtitle: { fontSize: 13, opacity: 0.9, marginTop: 2 },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  countPill: { borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  countPillText: { fontSize: 12, fontWeight: '800' },

  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
  },
  badgeLabel: { fontWeight: '800', letterSpacing: 0.5 },

  notice: {
    flexDirection: 'row',
    gap: spacing.sm,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noticeIcon: { fontSize: 16 },
  noticeBody: { flex: 1, gap: 2 },

  productCard: { marginBottom: spacing.md },
  productImage: { width: '100%', height: '100%' },
  imageDimmed: { opacity: 0.35 },
  imagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderGlyph: { fontSize: 34, opacity: 0.35 },
  soldOutOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  soldOutPill: {
    backgroundColor: '#111827e6',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  soldOutText: { color: '#ffffff', fontWeight: '800', letterSpacing: 1.5, fontSize: 13 },
  featuredPill: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
  },
  featuredText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  productBody: { padding: spacing.lg, gap: spacing.xs },
  productFooter: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
  },
  priceColumn: { gap: 2 },
  lowStock: { fontSize: 11, fontWeight: '700' },
  addButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addGlyph: { fontSize: 24, fontWeight: '600', lineHeight: 28 },

  rowItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  rowThumb: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  rowThumbImage: { width: '100%', height: '100%' },
  rowThumbGlyph: { fontSize: 22, opacity: 0.4 },
  rowItemBody: { flex: 1, gap: 2 },

  stepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.pill },
  stepperButton: { alignItems: 'center', justifyContent: 'center' },
  stepperGlyph: { fontSize: 20, fontWeight: '700' },
  stepperValue: { minWidth: 28, textAlign: 'center', fontSize: 16, fontWeight: '800' },
  dim: { opacity: 0.3 },

  segmented: { flexDirection: 'row', borderRadius: radius.md, padding: 3, gap: 3 },
  segmentedItemWrapper: { flex: 1 },
  segmentedItem: {
    minHeight: TOUCH_TARGET - 6,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },

  chip: {
    minHeight: TOUCH_TARGET - 8,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
  },
  chipLabel: { fontSize: 14, fontWeight: '600' },

  field: { gap: spacing.xs },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
  },

  statWrapper: { flex: 1 },
  statCard: {
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 92,
    justifyContent: 'space-between',
  },
  statValue: { fontSize: 30, fontWeight: '800', letterSpacing: -1 },
  statLabel: { fontSize: 12, fontWeight: '600', opacity: 0.85 },

  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },

  timeline: { gap: spacing.md, paddingVertical: spacing.sm },
  timelineSteps: { flexDirection: 'row', justifyContent: 'space-between' },
  timelineStep: { flex: 1, alignItems: 'center', gap: spacing.xs },
  timelineDot: { width: 12, height: 12, borderRadius: radius.pill, borderWidth: 3 },
  timelineLabel: { fontSize: 10, textAlign: 'center' },

  sheetBackdrop: { flex: 1, backgroundColor: '#0b112099', justifyContent: 'flex-end' },
  sheetDismiss: { flex: 1 },
  sheetDismissArea: { flex: 1, minHeight: 80 },
  sheet: {
    maxHeight: '85%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingBottom: spacing.xl,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    alignSelf: 'center',
    marginTop: spacing.sm,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  sheetClose: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.md },

  stickyBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.xxl : spacing.lg,
    gap: spacing.sm,
  },
});
