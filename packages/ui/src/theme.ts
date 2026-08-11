/**
 * Tokens de design.
 *
 * As cores da marca são resolvidas em TEMPO DE EXECUÇÃO a partir de
 * `branding_settings` da unidade — é o que permite atender várias franquias
 * com o mesmo binário, sem fork de código (docs/01, tematização por franquia).
 */

export const palette = {
  ink900: '#0f172a',
  ink700: '#334155',
  ink500: '#64748b',
  ink300: '#cbd5e1',
  ink100: '#f1f5f9',
  white: '#ffffff',

  brand: '#e11d48',
  brandDark: '#9f1239',

  success: '#15803d',
  successBg: '#dcfce7',
  warning: '#b45309',
  warningBg: '#fef3c7',
  danger: '#b91c1c',
  dangerBg: '#fee2e2',
  info: '#1d4ed8',
  infoBg: '#dbeafe',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

export const typography = {
  title: { fontSize: 24, fontWeight: '700' as const, color: palette.ink900 },
  heading: { fontSize: 18, fontWeight: '700' as const, color: palette.ink900 },
  body: { fontSize: 15, fontWeight: '400' as const, color: palette.ink700 },
  caption: { fontSize: 13, fontWeight: '400' as const, color: palette.ink500 },
  price: { fontSize: 17, fontWeight: '700' as const, color: palette.ink900 },
} as const;

export interface Theme {
  primary: string;
  onPrimary: string;
  surface: string;
  background: string;
}

export const defaultTheme: Theme = {
  primary: palette.brand,
  onPrimary: palette.white,
  surface: palette.white,
  background: palette.ink100,
};

/** Constrói o tema a partir do branding da unidade, com fallback seguro. */
export function themeFromBranding(branding?: { primaryColor?: string | null } | null): Theme {
  const primary =
    branding?.primaryColor && /^#[0-9a-fA-F]{6}$/.test(branding.primaryColor)
      ? branding.primaryColor
      : defaultTheme.primary;
  return { ...defaultTheme, primary };
}

/** Cores por status de pedido — as mesmas nos três aplicativos. */
export const statusColors: Record<string, { fg: string; bg: string }> = {
  PENDING: { fg: palette.warning, bg: palette.warningBg },
  CONFIRMED: { fg: palette.info, bg: palette.infoBg },
  PREPARING: { fg: palette.info, bg: palette.infoBg },
  READY: { fg: palette.success, bg: palette.successBg },
  AWAITING_PICKUP: { fg: palette.success, bg: palette.successBg },
  OUT_FOR_DELIVERY: { fg: palette.info, bg: palette.infoBg },
  DELIVERED: { fg: palette.ink500, bg: palette.ink100 },
  PICKED_UP: { fg: palette.ink500, bg: palette.ink100 },
  CANCELLED: { fg: palette.danger, bg: palette.dangerBg },
  REJECTED: { fg: palette.danger, bg: palette.dangerBg },
  EXPIRED: { fg: palette.danger, bg: palette.dangerBg },
};

export const paymentStatusColors: Record<string, { fg: string; bg: string }> = {
  PENDING: { fg: palette.warning, bg: palette.warningBg },
  AWAITING_CONFIRMATION: { fg: palette.warning, bg: palette.warningBg },
  CONFIRMED: { fg: palette.success, bg: palette.successBg },
  FAILED: { fg: palette.danger, bg: palette.dangerBg },
  REFUNDED: { fg: palette.ink500, bg: palette.ink100 },
  CANCELLED: { fg: palette.ink500, bg: palette.ink100 },
};
