import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ThemeProvider, adoptTheme, buildTheme, type AppTheme } from '@plataforma/ui';
import type { BranchSummary } from '@plataforma/client';
import { useSession } from './session.js';

/**
 * UNIDADE ATIVA + tema da unidade.
 *
 * O operador comum tem UMA unidade no escopo e nunca vê a escolha. O
 * administrador da franquia tem várias e troca pelo cabeçalho.
 *
 * A lista de unidades vem da vitrine pública da própria franquia. Deliberado:
 * é a lista que o cliente já enxerga, então não há informação nova exposta — e
 * o que o usuário PODE fazer em cada uma continua sendo decidido pelo servidor
 * a cada requisição, não por esta lista.
 */
interface BranchValue {
  branches: BranchSummary[];
  branchId: string | null;
  branch: BranchSummary | null;
  theme: AppTheme;
  loading: boolean;
  canSwitch: boolean;
  select: (branchId: string) => void;
  /** Recarrega a marca — chamado após salvar no editor de aparência. */
  reloadBranding: () => Promise<void>;
}

const BranchContext = createContext<BranchValue | null>(null);

export function BranchProvider({ children }: { children: React.ReactNode }) {
  const { api, profile, organizationSlug } = useSession();

  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [theme, setTheme] = useState<AppTheme>(buildTheme());
  const [loading, setLoading] = useState(true);

  // Unidades que este usuário alcança. Org-wide vê todas as da franquia;
  // operador vê apenas as do próprio escopo.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!profile || !organizationSlug) {
        setLoading(false);
        return;
      }
      try {
        const all = await api.listBranches(organizationSlug);
        const visible = profile.isOrgWide
          ? all
          : all.filter((b) => profile.branchScope.includes(b.id));
        if (cancelled) return;
        setBranches(visible);
        setBranchId((current) => current ?? visible[0]?.id ?? null);
      } catch {
        // Sem a lista, o app ainda funciona com a unidade do escopo: o painel
        // não pode ficar inutilizável porque a vitrine falhou.
        if (!cancelled) setBranchId((current) => current ?? profile.branchScope[0] ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, profile, organizationSlug]);

  const reloadBranding = useCallback(async () => {
    if (!branchId) return;
    try {
      const branding = await api.getBranding(branchId);
      setTheme(buildTheme(branding));
    } catch {
      // Aparência é secundária: se falhar, o painel continua no tema padrão.
      setTheme(buildTheme());
    }
  }, [api, branchId]);

  useEffect(() => {
    void reloadBranding();
  }, [reloadBranding]);

  const value = useMemo<BranchValue>(
    () => ({
      branches,
      branchId,
      branch: branches.find((b) => b.id === branchId) ?? null,
      theme,
      loading,
      canSwitch: branches.length > 1,
      select: setBranchId,
      reloadBranding,
    }),
    [branches, branchId, theme, loading, reloadBranding],
  );

  return (
    <BranchContext.Provider value={value}>
      <ThemeProvider value={theme}>{children}</ThemeProvider>
    </BranchContext.Provider>
  );
}

export function useBranch(): BranchValue {
  const value = useContext(BranchContext);
  if (!value) throw new Error('useBranch precisa estar dentro de <BranchProvider>');
  return value;
}

export { adoptTheme };
