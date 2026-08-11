import React, { createContext, useContext, useMemo } from 'react';
import { Platform } from 'react-native';
import {
  DEFAULT_BRANDING,
  mix,
  resolveTheme,
  withAlpha,
  type BrandingInput,
  type ResolvedTheme,
} from '@plataforma/domain';

/**
 * TEMA EM TEMPO DE EXECUÇÃO.
 *
 * O binário é um só; a marca vem do servidor. É isso que permite atender N
 * franquias sem fork de código — e é também o que torna o preview do
 * administrador possível: a mesma árvore de componentes, com outro valor no
 * provider, já desenha a loja inteira com a identidade nova.
 *
 * Nenhum componente importa cor de marca diretamente. Quem quiser a cor
 * primária chama `useTheme()`. Um componente que "chumbe" a cor quebra o
 * produto multifranquia inteiro, então essa disciplina não é estética.
 */

// ---------------------------------------------------------------------------
// Escalas fixas — não dependem da marca
// ---------------------------------------------------------------------------

/**
 * Espaçamento em escala de 4pt.
 *
 * O briefing pede "espaçamento" e "hierarquia visual" e proíbe "excesso de
 * elementos simultâneos". Escala fixa é o que impede o valor arbitrário
 * (`padding: 13`) que vai desalinhando as telas até a interface parecer
 * montada às pressas.
 */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = { xs: 6, sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;

/**
 * Profundidade por SOMBRA, não por borda.
 *
 * O briefing pede explicitamente para evitar "excesso de bordas". Cards
 * separados por elevação suave leem como produto moderno; separados por
 * traço de 1px em tudo, leem como planilha.
 */
export const elevation = {
  none: {},
  sm: Platform.select({
    ios: {
      shadowColor: '#0b1120',
      shadowOpacity: 0.06,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
    },
    android: { elevation: 2 },
    default: {},
  }),
  md: Platform.select({
    ios: {
      shadowColor: '#0b1120',
      shadowOpacity: 0.1,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 5 },
    default: {},
  }),
  lg: Platform.select({
    ios: {
      shadowColor: '#0b1120',
      shadowOpacity: 0.16,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: 14 },
    },
    android: { elevation: 10 },
    default: {},
  }),
} as const;

/**
 * Escala tipográfica.
 *
 * Os tamanhos NÃO são livres: uma escala fechada é o que produz hierarquia
 * legível. `lineHeight` acompanha cada degrau porque texto corrido com
 * entrelinha padrão do sistema fica apertado em telas pequenas.
 */
export const typeScale = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: '800' as const, letterSpacing: -0.6 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' as const, letterSpacing: -0.2 },
  subheading: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  micro: { fontSize: 11, lineHeight: 15, fontWeight: '700' as const, letterSpacing: 0.4 },
} as const;

export type TypeVariant = keyof typeof typeScale;

/** Alvo mínimo de toque. 44pt é o piso das diretrizes de iOS e Android. */
export const TOUCH_TARGET = 44;

// ---------------------------------------------------------------------------
// Cores de sinalização — semânticas, NÃO personalizáveis
// ---------------------------------------------------------------------------

/**
 * "Cancelado" precisa parecer cancelado em toda franquia.
 *
 * Se a cor de erro fosse configurável, uma loja poderia deixar o aviso de
 * pedido recusado em verde. Estado do sistema não é identidade de marca — e
 * essa separação também protege o contraste, já que estes pares foram
 * escolhidos e verificados uma vez.
 */
export const semantic = {
  success: '#0f7c4a',
  successBg: '#e6f6ed',
  warning: '#9a5b00',
  warningBg: '#fdf1dc',
  danger: '#b4232a',
  dangerBg: '#fdeaea',
  info: '#1b4fd8',
  infoBg: '#e8eefd',
  neutral: '#5b6478',
  neutralBg: '#eef0f4',
} as const;

export interface StatusTone {
  fg: string;
  bg: string;
  label: string;
}

/** Estado OPERACIONAL do pedido. */
export const orderStatusTone: Record<string, StatusTone> = {
  PENDING: { fg: semantic.warning, bg: semantic.warningBg, label: 'Novo' },
  CONFIRMED: { fg: semantic.info, bg: semantic.infoBg, label: 'Confirmado' },
  PREPARING: { fg: semantic.info, bg: semantic.infoBg, label: 'Em preparo' },
  READY: { fg: semantic.success, bg: semantic.successBg, label: 'Pronto' },
  AWAITING_PICKUP: { fg: semantic.success, bg: semantic.successBg, label: 'Aguardando retirada' },
  OUT_FOR_DELIVERY: { fg: semantic.info, bg: semantic.infoBg, label: 'Em rota' },
  DELIVERED: { fg: semantic.neutral, bg: semantic.neutralBg, label: 'Entregue' },
  PICKED_UP: { fg: semantic.neutral, bg: semantic.neutralBg, label: 'Retirado' },
  CANCELLED: { fg: semantic.danger, bg: semantic.dangerBg, label: 'Cancelado' },
  REJECTED: { fg: semantic.danger, bg: semantic.dangerBg, label: 'Recusado' },
  EXPIRED: { fg: semantic.danger, bg: semantic.dangerBg, label: 'Expirado' },
};

/**
 * Estado FINANCEIRO — máquina separada (Prompt 02, item 7).
 *
 * As duas aparecem lado a lado na interface justamente porque são
 * independentes: dá para estar "Em preparo" e "Aguardando pagamento".
 */
export const paymentStatusTone: Record<string, StatusTone> = {
  PENDING: { fg: semantic.warning, bg: semantic.warningBg, label: 'Pagamento pendente' },
  AWAITING_CONFIRMATION: {
    fg: semantic.warning,
    bg: semantic.warningBg,
    label: 'Aguardando confirmação',
  },
  CONFIRMED: { fg: semantic.success, bg: semantic.successBg, label: 'Pago' },
  FAILED: { fg: semantic.danger, bg: semantic.dangerBg, label: 'Falhou' },
  REFUNDED: { fg: semantic.neutral, bg: semantic.neutralBg, label: 'Estornado' },
  CANCELLED: { fg: semantic.neutral, bg: semantic.neutralBg, label: 'Cancelado' },
};

export function toneForOrder(status: string): StatusTone {
  return orderStatusTone[status] ?? { fg: semantic.neutral, bg: semantic.neutralBg, label: status };
}

export function toneForPayment(status: string): StatusTone {
  return (
    paymentStatusTone[status] ?? { fg: semantic.neutral, bg: semantic.neutralBg, label: status }
  );
}

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

/** O tema resolvido + as superfícies derivadas que os componentes consomem. */
export interface AppTheme extends ResolvedTheme {
  /** Fundo levemente afastado do card — usado em campos e estados vazios. */
  subtle: string;
  /** Fundo de um item pressionado. */
  pressed: string;
  /** Tinta clara da cor primária, para selos e realces. */
  primarySoft: string;
  displayName: string | null;
  tagline: string | null;
  logoUrl: string | null;
  /** Fonte da marca aplicada a um estilo de texto. */
  font: (variant: TypeVariant) => object;
}

export interface BrandIdentity {
  displayName?: string | null;
  tagline?: string | null;
  logoUrl?: string | null;
}

/**
 * Adota um tema JÁ RESOLVIDO — o caminho normal em produção.
 *
 * O servidor manda o tema pronto junto com o cardápio. Recalcular aqui seria
 * duplicar a regra de contraste em dois lugares que podem divergir entre uma
 * versão do app e outra.
 */
export function adoptTheme(resolved: ResolvedTheme, identity: BrandIdentity = {}): AppTheme {
  return {
    ...resolved,
    subtle: mix(resolved.card, resolved.text, 0.05),
    pressed: mix(resolved.card, resolved.text, 0.09),
    primarySoft: mix(resolved.card, resolved.primary, 0.14),
    displayName: identity.displayName ?? null,
    tagline: identity.tagline ?? null,
    logoUrl: identity.logoUrl ?? null,
    font: (variant: TypeVariant) => ({
      ...typeScale[variant],
      color: resolved.text,
      ...(resolved.fontFamily ? { fontFamily: resolved.fontFamily } : {}),
    }),
  };
}

/**
 * Resolve a partir da configuração CRUA.
 *
 * Usado só onde o tema ainda não passou pelo servidor: o preview do editor de
 * aparência, que precisa desenhar cada tecla digitada antes de qualquer
 * gravação. É a mesma função `resolveTheme` do domínio que o servidor usa, e é
 * isso que faz o preview corresponder ao resultado real.
 */
export function buildTheme(branding?: (BrandingInput & BrandIdentity) | null): AppTheme {
  return adoptTheme(resolveTheme(branding ?? null), branding ?? {});
}

export const defaultTheme = buildTheme(DEFAULT_BRANDING);

const ThemeContext = createContext<AppTheme>(defaultTheme);

/**
 * Provider do tema.
 *
 * Aceita o tema JÁ PRONTO (`value`) ou o branding cru. O editor de aparência
 * usa a primeira forma para renderizar o preview com um tema diferente do
 * resto do app — dois provedores aninhados, sem estado global, sem "modo
 * preview" espalhado pelos componentes.
 */
export function ThemeProvider({
  branding,
  value,
  children,
}: {
  branding?: (BrandingInput & { displayName?: string | null; logoUrl?: string | null }) | null;
  value?: AppTheme;
  children: React.ReactNode;
}) {
  const theme = useMemo(() => value ?? buildTheme(branding), [value, branding]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): AppTheme {
  return useContext(ThemeContext);
}

/** Sobreposição translúcida sobre a foto — usada no selo ESGOTADO. */
export function scrim(theme: AppTheme, alpha = 0.55): string {
  return withAlpha(theme.text, alpha);
}
