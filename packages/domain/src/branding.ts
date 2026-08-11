/**
 * IDENTIDADE VISUAL DA UNIDADE — regras puras.
 *
 * Este módulo é a razão de a personalização ser segura. Ele vive no pacote de
 * domínio porque as MESMAS regras precisam rodar em dois lugares:
 *
 *  - no servidor, que DECIDE o que pode ser gravado;
 *  - no app do administrador, que mostra o preview em tempo real.
 *
 * Se as regras fossem duplicadas, o preview aceitaria algo que o servidor
 * recusa (ou pior: mostraria algo diferente do que o cliente vai ver).
 *
 * ------------------------------------------------------------------------
 * POR QUE NÃO EXISTE INJEÇÃO DE CSS/HTML AQUI
 * ------------------------------------------------------------------------
 * O briefing exige: "Não permitir que o usuário injete CSS ou HTML arbitrário."
 *
 * A defesa não é sanitização — é ausência de superfície. Nenhum campo de
 * aparência aceita texto livre que vire estilo:
 *
 *  - fonte  → TOKEN de uma lista fechada (`INTER`, `POPPINS`, …). O nome real
 *             da família nunca vem do usuário; vem desta tabela.
 *  - cor    → exatamente `#RRGGBB`, validado por regex ancorada e re-emitido
 *             normalizado. `#fff; background: url(javascript:…)` não é uma cor.
 *  - gradiente → TOKEN de lista fechada; os ângulos são nossos, não dele.
 *
 * Ou seja: o que é gravado no banco não é estilo, é ENUMERAÇÃO. Mesmo que
 * alguém escreva direto na tabela, o app só sabe renderizar os tokens que
 * conhece — e cai no padrão quando não reconhece.
 */

// ---------------------------------------------------------------------------
// Fontes
// ---------------------------------------------------------------------------

/**
 * Lista segura de tipografias.
 *
 * `family` é o nome que o React Native usa depois que a fonte é carregada pelo
 * app (via `expo-font`, empacotada no binário). Nenhuma fonte é baixada de URL
 * informada pelo lojista — isso seria requisição de rede controlada por
 * terceiro dentro do app de todo mundo.
 */
export const BRAND_FONTS = [
  { token: 'INTER', label: 'Inter', family: 'Inter' },
  { token: 'POPPINS', label: 'Poppins', family: 'Poppins' },
  { token: 'MONTSERRAT', label: 'Montserrat', family: 'Montserrat' },
  { token: 'ROBOTO', label: 'Roboto', family: 'Roboto' },
  { token: 'NUNITO', label: 'Nunito', family: 'Nunito' },
  { token: 'DM_SANS', label: 'DM Sans', family: 'DMSans' },
] as const;

export type FontToken = (typeof BRAND_FONTS)[number]['token'];

export const FONT_TOKENS: readonly FontToken[] = BRAND_FONTS.map((f) => f.token);

export function isFontToken(value: unknown): value is FontToken {
  return typeof value === 'string' && FONT_TOKENS.includes(value as FontToken);
}

/**
 * Nome da família a usar no `StyleSheet`.
 *
 * Token desconhecido devolve `undefined`, e é isso que faz o React Native usar
 * a fonte padrão da plataforma (San Francisco no iOS, Roboto no Android). O
 * valor recebido NUNCA é repassado como nome de família — é essa linha que
 * impede um `fontToken` hostil de virar estilo.
 */
export function fontFamilyOf(token: string | null | undefined): string | undefined {
  return BRAND_FONTS.find((f) => f.token === token)?.family;
}

// ---------------------------------------------------------------------------
// Gradientes
// ---------------------------------------------------------------------------

/**
 * Estilos de gradiente disponíveis. O lojista escolhe o ESTILO e as duas cores;
 * os pontos de início/fim são definidos aqui.
 */
export const GRADIENT_STYLES = [
  { token: 'NONE', label: 'Cor sólida', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } },
  { token: 'VERTICAL', label: 'Vertical', start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } },
  { token: 'HORIZONTAL', label: 'Horizontal', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } },
  { token: 'DIAGONAL', label: 'Diagonal', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
  { token: 'DIAGONAL_REVERSE', label: 'Diagonal invertida', start: { x: 1, y: 0 }, end: { x: 0, y: 1 } },
] as const;

export type GradientStyle = (typeof GRADIENT_STYLES)[number]['token'];

export const GRADIENT_TOKENS: readonly GradientStyle[] = GRADIENT_STYLES.map((g) => g.token);

export function isGradientStyle(value: unknown): value is GradientStyle {
  return typeof value === 'string' && GRADIENT_TOKENS.includes(value as GradientStyle);
}

export function gradientGeometry(style: GradientStyle) {
  const found = GRADIENT_STYLES.find((g) => g.token === style) ?? GRADIENT_STYLES[0];
  return { start: found.start, end: found.end };
}

// ---------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** `#AABBCC` normalizado em minúsculas, ou `null` se não for exatamente isso. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!HEX_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function isHexColor(value: unknown): boolean {
  return normalizeHex(value) !== null;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHex(hex);
  if (!normalized) throw new BrandingError('COR_INVALIDA', `Cor inválida: ${String(hex)}`);
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Luminância relativa (WCAG 2.1, §Relative luminance).
 * É o degrau necessário para calcular contraste de verdade — "escurecer um
 * pouco" no olho não é critério de acessibilidade.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Razão de contraste WCAG entre duas cores: de 1 (idênticas) a 21 (preto/branco). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Mínimos WCAG 2.1 AA. */
export const CONTRAST_AA_TEXT = 4.5;
export const CONTRAST_AA_LARGE_TEXT = 3;

/**
 * Escolhe a cor de texto que fica legível SOBRE `background`.
 *
 * Isto NÃO é configurável de propósito. Se o lojista pudesse escolher a cor do
 * texto do botão e a cor do botão de forma independente, o primeiro erro de
 * combinação produziria um botão de texto invisível — em produção, no app do
 * cliente dele. Derivar remove a classe inteira de problema.
 *
 * Os candidatos são o BRANCO e o PRETO puros, e isso importa. Uma cor de meio
 * tom pode falhar contra os dois se afrouxarmos qualquer um dos extremos: com
 * `#111111` no lugar do preto, `#6666ff` fica em 4,41:1 e reprova em AA. Com os
 * extremos puros existe um piso demonstrável — a pior luminância possível é
 * L = √0,0525 − 0,05, que ainda alcança 4,583:1. Ou seja: QUALQUER cor de marca
 * que o lojista escolher produz texto legível. O teste varre o espaço de cor
 * para travar essa propriedade.
 */
export function bestTextOn(background: string, options?: { light?: string; dark?: string }): string {
  const light = normalizeHex(options?.light) ?? '#ffffff';
  const dark = normalizeHex(options?.dark) ?? '#000000';
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

/**
 * Piso de contraste garantido por `bestTextOn` para qualquer cor de entrada.
 * Acima do mínimo AA (4,5) — por pouco, mas por construção, não por sorte.
 */
export const GUARANTEED_MIN_CONTRAST = 1.05 / Math.sqrt(0.0525);

/** Mistura duas cores (0 = `a`, 1 = `b`). Usado para bordas e estados sutis. */
export function mix(a: string, b: string, amount: number): string {
  const t = Math.max(0, Math.min(1, amount));
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  });
}

/** Versão translúcida em `#RRGGBBAA` — para sobreposições (ex.: selo ESGOTADO). */
export function withAlpha(hex: string, alpha: number): string {
  const normalized = normalizeHex(hex);
  if (!normalized) throw new BrandingError('COR_INVALIDA', `Cor inválida: ${String(hex)}`);
  const a = Math.max(0, Math.min(1, alpha));
  return `${normalized}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Entrada e validação
// ---------------------------------------------------------------------------

export class BrandingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrandingError';
  }
}

/** O que o administrador consegue configurar. Nada além disto. */
export interface BrandingInput {
  displayName?: string | null;
  tagline?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  textColor?: string | null;
  backgroundColor?: string | null;
  cardColor?: string | null;
  fontToken?: string | null;
  gradientStyle?: string | null;
  gradientFrom?: string | null;
  gradientTo?: string | null;
}

export interface BrandingIssue {
  field: keyof BrandingInput;
  code: string;
  message: string;
}

export interface NormalizedBranding {
  displayName: string | null;
  tagline: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  textColor: string;
  backgroundColor: string;
  cardColor: string;
  fontToken: FontToken;
  gradientStyle: GradientStyle;
  gradientFrom: string;
  gradientTo: string;
}

/** Identidade padrão: o app precisa ser bonito ANTES de alguém configurar nada. */
export const DEFAULT_BRANDING: NormalizedBranding = {
  displayName: null,
  tagline: null,
  primaryColor: '#e11d48',
  secondaryColor: '#0f172a',
  accentColor: '#f59e0b',
  textColor: '#0f172a',
  backgroundColor: '#f6f7f9',
  cardColor: '#ffffff',
  fontToken: 'INTER',
  gradientStyle: 'DIAGONAL',
  gradientFrom: '#e11d48',
  gradientTo: '#f59e0b',
};

const MAX_DISPLAY_NAME = 60;
const MAX_TAGLINE = 120;

/**
 * Caracteres de controle e formatação bidirecional.
 *
 * O nome do estabelecimento aparece no card do operador e nas notificações. Um
 * override RTL (U+202E) escondido no nome inverte visualmente o texto ao redor
 * — truque clássico para disfarçar conteúdo. Não é XSS em React Native (não há
 * interpretação de HTML), mas é falsificação visual, e o campo não tem nenhuma
 * razão legítima para conter esses pontos de código.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

function validateText(
  value: unknown,
  field: keyof BrandingInput,
  maxLength: number,
  issues: BrandingIssue[],
): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    issues.push({ field, code: 'TIPO_INVALIDO', message: 'Texto esperado.' });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    issues.push({
      field,
      code: 'TEXTO_LONGO',
      message: `Use no máximo ${maxLength} caracteres.`,
    });
    return null;
  }
  if (UNSAFE_TEXT_RE.test(trimmed)) {
    issues.push({
      field,
      code: 'CARACTERE_NAO_PERMITIDO',
      message: 'Remova caracteres invisíveis ou de controle.',
    });
    return null;
  }
  return trimmed;
}

function validateColor(
  value: unknown,
  field: keyof BrandingInput,
  fallback: string,
  issues: BrandingIssue[],
): string {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = normalizeHex(value);
  if (!normalized) {
    issues.push({
      field,
      code: 'COR_INVALIDA',
      message: 'Informe uma cor no formato #RRGGBB.',
    });
    return fallback;
  }
  return normalized;
}

/**
 * Valida e normaliza. Devolve SEMPRE um branding utilizável (com os padrões nos
 * campos ausentes) mais a lista de problemas encontrados.
 *
 * O servidor recusa quando há problema; o preview usa o valor normalizado para
 * continuar desenhando enquanto mostra o erro — mais útil que uma tela em
 * branco enquanto o lojista digita.
 */
export function validateBranding(input: BrandingInput): {
  ok: boolean;
  issues: BrandingIssue[];
  value: NormalizedBranding;
} {
  const issues: BrandingIssue[] = [];

  const value: NormalizedBranding = {
    displayName: validateText(input.displayName, 'displayName', MAX_DISPLAY_NAME, issues),
    tagline: validateText(input.tagline, 'tagline', MAX_TAGLINE, issues),
    primaryColor: validateColor(input.primaryColor, 'primaryColor', DEFAULT_BRANDING.primaryColor, issues),
    secondaryColor: validateColor(input.secondaryColor, 'secondaryColor', DEFAULT_BRANDING.secondaryColor, issues),
    accentColor: validateColor(input.accentColor, 'accentColor', DEFAULT_BRANDING.accentColor, issues),
    textColor: validateColor(input.textColor, 'textColor', DEFAULT_BRANDING.textColor, issues),
    backgroundColor: validateColor(input.backgroundColor, 'backgroundColor', DEFAULT_BRANDING.backgroundColor, issues),
    cardColor: validateColor(input.cardColor, 'cardColor', DEFAULT_BRANDING.cardColor, issues),
    fontToken: isFontToken(input.fontToken) ? input.fontToken : DEFAULT_BRANDING.fontToken,
    gradientStyle: isGradientStyle(input.gradientStyle)
      ? input.gradientStyle
      : DEFAULT_BRANDING.gradientStyle,
    gradientFrom: validateColor(input.gradientFrom, 'gradientFrom', DEFAULT_BRANDING.gradientFrom, issues),
    gradientTo: validateColor(input.gradientTo, 'gradientTo', DEFAULT_BRANDING.gradientTo, issues),
  };

  if (input.fontToken !== null && input.fontToken !== undefined && !isFontToken(input.fontToken)) {
    issues.push({
      field: 'fontToken',
      code: 'FONTE_NAO_PERMITIDA',
      message: `Escolha uma das fontes disponíveis: ${FONT_TOKENS.join(', ')}.`,
    });
  }

  if (
    input.gradientStyle !== null &&
    input.gradientStyle !== undefined &&
    !isGradientStyle(input.gradientStyle)
  ) {
    issues.push({
      field: 'gradientStyle',
      code: 'GRADIENTE_NAO_PERMITIDO',
      message: `Escolha um dos estilos: ${GRADIENT_TOKENS.join(', ')}.`,
    });
  }

  issues.push(...contrastIssues(value));

  return { ok: issues.length === 0, issues, value };
}

/**
 * Contraste mínimo — acessibilidade tratada como REGRA, não como recomendação.
 *
 * O briefing pede contraste no item 11. Deixar isso só na documentação
 * significa que a primeira franquia que escolher cinza-claro sobre branco vai
 * publicar um cardápio ilegível para todo mundo. Por isso é validação, e o
 * servidor recusa.
 *
 * Só entram aqui os pares que REALMENTE se sobrepõem na tela. Cores que nunca
 * encostam uma na outra não precisam contrastar entre si.
 */
export function contrastIssues(value: NormalizedBranding): BrandingIssue[] {
  const issues: BrandingIssue[] = [];

  const check = (
    fg: string,
    bg: string,
    field: keyof BrandingInput,
    min: number,
    where: string,
  ) => {
    const ratio = contrastRatio(fg, bg);
    if (ratio < min) {
      issues.push({
        field,
        code: 'CONTRASTE_INSUFICIENTE',
        message: `${where}: contraste ${ratio.toFixed(1)}:1 — mínimo ${min}:1 para leitura confortável.`,
      });
    }
  };

  check(value.textColor, value.backgroundColor, 'textColor', CONTRAST_AA_TEXT, 'Texto sobre o fundo');
  check(value.textColor, value.cardColor, 'cardColor', CONTRAST_AA_TEXT, 'Texto sobre o card');
  // O card precisa se distinguir do fundo, senão a hierarquia de profundidade
  // desaparece — não é leitura, é separação de superfície: exigimos menos.
  const surface = contrastRatio(value.cardColor, value.backgroundColor);
  if (surface < 1.05 && value.cardColor === value.backgroundColor) {
    issues.push({
      field: 'cardColor',
      code: 'CARD_IGUAL_AO_FUNDO',
      message: 'A cor do card precisa ser diferente da cor do fundo.',
    });
  }
  // Primária e destaque aparecem como botão e selo, sempre com texto derivado
  // por cima — então o que precisa contrastar é a cor CONTRA O FUNDO, para o
  // botão não sumir na tela.
  check(value.primaryColor, value.backgroundColor, 'primaryColor', CONTRAST_AA_LARGE_TEXT, 'Cor principal sobre o fundo');

  return issues;
}

// ---------------------------------------------------------------------------
// Tema resolvido
// ---------------------------------------------------------------------------

/**
 * O que os componentes realmente consomem.
 *
 * Repare no que é DERIVADO e não configurável: `onPrimary`, `onAccent`,
 * `mutedText`, `border`, `overlay`. Quanto menos o lojista precisa acertar,
 * menos ele consegue errar.
 */
export interface ResolvedTheme {
  primary: string;
  onPrimary: string;
  secondary: string;
  onSecondary: string;
  accent: string;
  onAccent: string;
  text: string;
  mutedText: string;
  background: string;
  card: string;
  border: string;
  overlay: string;
  fontToken: FontToken;
  fontFamily: string | undefined;
  gradient: {
    style: GradientStyle;
    colors: readonly [string, string];
    start: { x: number; y: number };
    end: { x: number; y: number };
    enabled: boolean;
  };
}

export function resolveTheme(input?: BrandingInput | null): ResolvedTheme {
  // Deliberadamente usamos o valor NORMALIZADO mesmo quando há problemas: um
  // branding inválido gravado antes de uma regra nova não pode derrubar a
  // vitrine do lojista. Campo ruim cai no padrão; a tela continua de pé.
  const { value } = validateBranding(input ?? {});
  const geometry = gradientGeometry(value.gradientStyle);
  const gradientEnabled = value.gradientStyle !== 'NONE';

  return {
    primary: value.primaryColor,
    onPrimary: bestTextOn(value.primaryColor),
    secondary: value.secondaryColor,
    onSecondary: bestTextOn(value.secondaryColor),
    accent: value.accentColor,
    onAccent: bestTextOn(value.accentColor),
    text: value.textColor,
    mutedText: mix(value.textColor, value.backgroundColor, 0.45),
    background: value.backgroundColor,
    card: value.cardColor,
    border: mix(value.cardColor, value.textColor, 0.12),
    overlay: withAlpha(value.textColor, 0.55),
    fontToken: value.fontToken,
    fontFamily: fontFamilyOf(value.fontToken),
    gradient: {
      style: value.gradientStyle,
      // Com gradiente desligado, as duas paradas são a cor principal: quem
      // desenha o cabeçalho não precisa de dois caminhos de código.
      colors: gradientEnabled
        ? [value.gradientFrom, value.gradientTo]
        : [value.primaryColor, value.primaryColor],
      start: geometry.start,
      end: geometry.end,
      enabled: gradientEnabled,
    },
  };
}
