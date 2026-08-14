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

/** Preço e disponibilidade mudam sem que o cliente recarregue a página. */
const MENU_REFRESH_MS = 10_000;

export function StoreProvider({ children }: { children: ReactNode }) {
  const { organizationSlug = '', branchSlug = '' } = useParams();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMenu(null);

    function applyLoadedMenu(loaded: Menu) {
      setMenu(loaded);
      // Aplicado no elemento raiz para valer em toda a página, inclusive na
      // cor de fundo do body.
      applyTheme(document.documentElement, loaded.theme);
      document.title = loaded.theme.displayName ?? loaded.branch.name;
    }

    api
      .getMenu(organizationSlug, branchSlug)
      .then((loaded) => {
        if (cancelled) return;
        applyLoadedMenu(loaded);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    /**
     * Atualização silenciosa: preço e disponibilidade podem mudar enquanto o
     * cliente está com o cardápio aberto no celular. Uma falha aqui (rede
     * instável, loja momentaneamente fora do ar) não deve jogar quem já está
     * navegando numa tela de erro — só pula aquele ciclo e tenta de novo no
     * próximo, exatamente como o refresh automático de qualquer app comum.
     */
    function refresh() {
      if (document.visibilityState !== 'visible') return;
      api
        .getMenu(organizationSlug, branchSlug)
        .then((loaded) => {
          if (!cancelled) applyLoadedMenu(loaded);
        })
        .catch(() => {
          // silencioso de propósito — ver comentário acima.
        });
    }

    const interval = setInterval(refresh, MENU_REFRESH_MS);
    // Volta do plano de fundo (tela bloqueada, troca de app): a espera desde
    // a última atualização pode já ter passado do intervalo normal.
    document.addEventListener('visibilitychange', refresh);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
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
