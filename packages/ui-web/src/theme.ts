import { resolveTheme, type BrandingInput, type ResolvedTheme } from '@plataforma/domain';

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

export function themeToCssVars(theme: Theme): Record<string, string> {
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
    '--c-success': SEMANTIC.success,
    '--c-warning': SEMANTIC.warning,
    '--c-danger': SEMANTIC.danger,
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

/** Aplica o tema a um elemento (normalmente `document.documentElement`). */
export function applyTheme(element: HTMLElement, theme: Theme): void {
  for (const [name, value] of Object.entries(themeToCssVars(theme))) {
    element.style.setProperty(name, value);
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
