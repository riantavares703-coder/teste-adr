import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { palette, radius, spacing, typography } from './theme.js';

export * from './theme.js';

// --- Botão -------------------------------------------------------------------

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  color,
  style,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const background =
    variant === 'primary'
      ? (color ?? palette.brand)
      : variant === 'danger'
        ? palette.danger
        : variant === 'secondary'
          ? palette.ink100
          : 'transparent';
  const textColor =
    variant === 'primary' || variant === 'danger' ? palette.white : palette.ink900;
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled }}
      onPress={isDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && styles.buttonGhost,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <Text style={[styles.buttonLabel, { color: textColor }]}>{label}</Text>
      )}
    </Pressable>
  );
}

// --- Cartão ------------------------------------------------------------------

export function Card({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  const content = <View style={[styles.card, style]}>{children}</View>;
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

// --- Selo de status ----------------------------------------------------------

export function Badge({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeLabel, { color: fg }]}>{label}</Text>
    </View>
  );
}

// --- Preço -------------------------------------------------------------------

export function Price({ cents, size = 'md' }: { cents: number; size?: 'sm' | 'md' | 'lg' }) {
  const fontSize = size === 'lg' ? 22 : size === 'sm' ? 14 : 17;
  return (
    <Text style={[typography.price, { fontSize }]}>{formatBRL(cents)}</Text>
  );
}

function formatBRL(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}R$ ${Math.floor(abs / 100).toLocaleString('pt-BR')},${String(abs % 100).padStart(2, '0')}`;
}

// --- Seletor de quantidade ---------------------------------------------------

export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number | null;
}) {
  const canDecrease = value > min;
  const canIncrease = max === null || max === undefined || value < max;

  return (
    <View style={styles.stepper}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Diminuir quantidade"
        disabled={!canDecrease}
        onPress={() => onChange(value - 1)}
        style={[styles.stepperButton, !canDecrease && styles.stepperDisabled]}
      >
        <Text style={styles.stepperSymbol}>−</Text>
      </Pressable>
      <Text accessibilityLabel={`Quantidade ${value}`} style={styles.stepperValue}>
        {value}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Aumentar quantidade"
        disabled={!canIncrease}
        onPress={() => onChange(value + 1)}
        style={[styles.stepperButton, !canIncrease && styles.stepperDisabled]}
      >
        <Text style={styles.stepperSymbol}>+</Text>
      </Pressable>
    </View>
  );
}

// --- Estados -----------------------------------------------------------------

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={typography.heading}>{title}</Text>
      {description ? <Text style={[typography.caption, styles.emptyText]}>{description}</Text> : null}
    </View>
  );
}

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={palette.brand} />
      <Text style={[typography.caption, styles.emptyText]}>{label}</Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.empty}>
      <Text style={[typography.heading, { color: palette.danger }]}>Algo deu errado</Text>
      <Text style={[typography.caption, styles.emptyText]}>{message}</Text>
      {onRetry ? <Button label="Tentar de novo" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

/** Aviso de destaque — usado para o alerta de que copiar o Pix não confirma. */
export function Notice({
  tone = 'warning',
  children,
}: {
  tone?: 'warning' | 'info' | 'danger';
  children: React.ReactNode;
}) {
  const map = {
    warning: { bg: palette.warningBg, fg: palette.warning },
    info: { bg: palette.infoBg, fg: palette.info },
    danger: { bg: palette.dangerBg, fg: palette.danger },
  }[tone];

  return (
    <View style={[styles.notice, { backgroundColor: map.bg, borderLeftColor: map.fg }]}>
      <Text style={[typography.body, { color: map.fg }]}>{children}</Text>
    </View>
  );
}

export function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={strong ? typography.heading : typography.body}>{label}</Text>
      <Text style={strong ? typography.price : typography.body}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48, // alvo de toque acessível
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonGhost: { borderWidth: 1, borderColor: palette.ink300 },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  card: {
    backgroundColor: palette.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: palette.ink100,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgeLabel: { fontSize: 12, fontWeight: '700' },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: palette.ink300,
    borderRadius: radius.pill,
  },
  stepperButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  stepperDisabled: { opacity: 0.3 },
  stepperSymbol: { fontSize: 20, fontWeight: '700', color: palette.ink900 },
  stepperValue: { minWidth: 32, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.sm },
  emptyText: { textAlign: 'center' },
  notice: {
    borderLeftWidth: 4,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
});
