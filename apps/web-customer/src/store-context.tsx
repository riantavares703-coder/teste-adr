import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ApiClient, type Menu } from '@plataforma/client';
import { AsyncBoundary, applyTheme } from '@plataforma/ui-web';

/**
 * Contexto da loja.
 *
 * Carrega o cardápio da unidade indicada na URL e aplica o tema que o SERVIDOR
 * resolveu. O cliente chega por QR code sem escolher loja: a loja é a URL.
 */
interface StoreValue {
  api: ApiClient;
  menu: Menu;
  organizationSlug: string;
  branchSlug: string;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore precisa estar dentro de <StoreProvider>');
  return value;
}

/**
 * O cardápio é servido pela MESMA origem da API, então a base é relativa —
 * nenhuma configuração de endereço para o dono do restaurante errar.
 */
const api = new ApiClient(window.location.origin, {
  async getRefreshToken() {
    return localStorage.getItem('refresh_token');
  },
  async setRefreshToken(token) {
    if (token) localStorage.setItem('refresh_token', token);
    else localStorage.removeItem('refresh_token');
  },
});

export function StoreProvider({ children }: { children: ReactNode }) {
  const { organizationSlug = '', branchSlug = '' } = useParams();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getMenu(organizationSlug, branchSlug)
      .then((loaded) => {
        if (cancelled) return;
        setMenu(loaded);
        // Aplicado no elemento raiz para valer em toda a página, inclusive na
        // cor de fundo do body.
        applyTheme(document.documentElement, loaded.theme);
        document.title = loaded.theme.displayName ?? loaded.branch.name;
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [organizationSlug, branchSlug]);

  const value = useMemo(
    () => (menu ? { api, menu, organizationSlug, branchSlug } : null),
    [menu, organizationSlug, branchSlug],
  );

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={() => window.location.reload()}>
      {value ? <StoreContext.Provider value={value}>{children}</StoreContext.Provider> : null}
    </AsyncBoundary>
  );
}
