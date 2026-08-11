import type { BrandingSettings, BrandingInput } from '@plataforma/domain';
import { resolveTheme, contrastIssues } from '@plataforma/domain';

export interface Theme {
  primary: string;
  accent: string;
  background: string;
  card: string;
  text: string;
  onPrimary: string;
  onAccent: string;
  border: string;
  overlay: string;
  mutedText: string;
  success: string;
  warning: string;
  danger: string;
}

export function adoptTheme(branding: BrandingSettings): Theme {
  const resolved = resolveTheme(branding);

  return {
    primary: resolved.primary,
    accent: resolved.accent,
    background: resolved.background,
    card: resolved.card,
    text: resolved.text,
    onPrimary: resolved.onPrimary,
    onAccent: resolved.onAccent,
    border: resolved.border,
    overlay: resolved.overlay,
    mutedText: resolved.mutedText,
    success: '#10b981',
    warning: '#f59e0b',
    danger: '#ef4444',
  };
}

export function validateBrandingForWeb(input: BrandingInput): string[] {
  return contrastIssues(input);
}
