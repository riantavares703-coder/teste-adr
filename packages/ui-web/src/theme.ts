import { useSyncExternalStore } from 'react';
import { resolveTheme, toDarkTheme, type BrandingInput, type ResolvedTheme } from '@plataforma/domain';

/**
 * TEMA NA WEB.
 *
 * O servidor já devolve o tema resolvido (`GET /v1/public/:org/:branch/menu`
 * traz `theme` pronto). O app NÃO recalcula cor: recalcular seria uma segunda
 * implementação das regras de contraste, livre para divergir da primeira.
 *
 * A aplicação é feita por variáveis CSS em vez de props. Duas razões práticas:
 * qualquer componente lê a cor sem receber `theme` por parâmetro, e trocar o
 * tema (o preview ao vivo do editor de aparência) é reescrever um punhado de
 * variáveis num nó, não re-renderizar a árvore inteira.
 */
export type Theme = ResolvedTheme;

/** Cores de significado fixo: NÃO são personalizáveis pelo lojista. */
export const SEMANTIC = {
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  onSemantic: '#ffffff',
} as const;

/** No escuro, os tons semânticos clareiam para manter contraste sobre superfícies escuras. */
const SEMANTIC_DARK = { success: '#34d399', warning: '#fbbf24', danger: '#f87171' } as const;

export function themeToCssVars(theme: Theme, scheme: 'light' | 'dark' = 'light'): Record<string, string> {
  const semantic = scheme === 'dark' ? SEMANTIC_DARK : SEMANTIC;
  const vars: Record<string, string> = {
    '--c-primary': theme.primary,
    '--c-on-primary': theme.onPrimary,
    '--c-secondary': theme.secondary,
    '--c-on-secondary': theme.onSecondary,
    '--c-accent': theme.accent,
    '--c-on-accent': theme.onAccent,
    '--c-text': theme.text,
    '--c-muted': theme.mutedText,
    '--c-bg': theme.background,
    '--c-card': theme.card,
    '--c-border': theme.border,
    '--c-overlay': theme.overlay,
    '--c-success': semantic.success,
    '--c-warning': semantic.warning,
    '--c-danger': semantic.danger,
    '--c-on-danger': scheme === 'dark' ? '#1a0505' : SEMANTIC.onSemantic,
    // A fonte é um token fechado do domínio; se não houver família mapeada,
    // cai na pilha do sistema em vez de aceitar um nome livre.
    '--font-brand': theme.fontFamily
      ? `"${theme.fontFamily}", system-ui, sans-serif`
      : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  };

  const { gradient } = theme;
  vars['--brand-gradient'] = gradient.enabled
    ? `linear-gradient(${gradientAngle(gradient)}, ${gradient.colors[0]}, ${gradient.colors[1]})`
    : theme.primary;

  return vars;
}

/**
 * Converte a geometria do domínio (pontos início/fim) no ângulo do CSS.
 * O domínio descreve o gradiente em coordenadas porque foi escrito para o
 * mobile; na web o equivalente é um ângulo em graus.
 */
function gradientAngle(gradient: Theme['gradient']): string {
  const dx = gradient.end.x - gradient.start.x;
  const dy = gradient.end.y - gradient.start.y;
  // 0deg no CSS aponta para cima; o eixo Y da geometria cresce para baixo.
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return `${Math.round(((degrees % 360) + 360) % 360)}deg`;
}

/**
 * MODO CLARO / ESCURO / AUTOMÁTICO.
 *
 * O tema que o servidor resolve (cores da marca da loja) é sempre o CLARO; o
 * escuro é derivado dele no navegador por `toDarkTheme`, que preserva a marca e
 * garante contraste. A escolha do usuário fica no aparelho (localStorage) e
 * "automático" segue o sistema operacional.
 */
export type ColorScheme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'ui-color-scheme';
const isBrowser = typeof document !== 'undefined';

function readPreference(): ColorScheme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

let preference: ColorScheme = isBrowser ? readPreference() : 'system';
let lightTheme: Theme = resolveTheme();
const listeners = new Set<() => void>();

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function effectiveScheme(): 'light' | 'dark' {
  return preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference;
}

function render(): void {
  if (!isBrowser) return;
  const root = document.documentElement;
  const scheme = effectiveScheme();
  const theme = scheme === 'dark' ? toDarkTheme(lightTheme) : lightTheme;
  for (const [name, value] of Object.entries(themeToCssVars(theme, scheme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
  listeners.forEach((l) => l());
}

export function getColorScheme(): ColorScheme {
  return preference;
}

export function setColorScheme(next: ColorScheme): void {
  preference = next;
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // sem armazenamento (modo privado): vale só nesta sessão
  }
  render();
}

export function useColorScheme(): { preference: ColorScheme; scheme: 'light' | 'dark' } {
  const pref = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => preference,
    () => 'system' as ColorScheme,
  );
  return { preference: pref, scheme: effectiveScheme() };
}

/** Aplica o tema (claro) da loja ao documento; o escuro é derivado dele. */
export function applyTheme(element: HTMLElement, theme: Theme): void {
  if (element === document.documentElement) {
    lightTheme = theme;
    render();
    return;
  }
  for (const [name, value] of Object.entries(themeToCssVars(theme))) {
    element.style.setProperty(name, value);
  }
}

if (isBrowser) {
  // Aplica na carga do módulo: evita o clarão branco antes do React montar.
  render();
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (preference === 'system') render();
    });
  }
}

/**
 * Resolve um tema localmente.
 *
 * Uso legítimo: o PREVIEW do editor de aparência, que precisa mostrar o
 * resultado antes de gravar. Fora disso, use o tema que veio do servidor.
 */
export function previewTheme(input: BrandingInput): Theme {
  return resolveTheme(input);
}
