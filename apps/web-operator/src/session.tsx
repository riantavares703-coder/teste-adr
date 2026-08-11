import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, type BranchSummary, type Profile } from '@plataforma/client';
import { LoadingState } from '@plataforma/ui-web';

/**
 * Sessão do operador.
 *
 * As permissões vêm do SERVIDOR a cada `me()` — nunca são lidas do token nem
 * guardadas em disco. Esconder um botão é conveniência de tela; quem recusa a
 * operação é a API. Guardar permissão localmente só criaria uma segunda fonte
 * de verdade, livre para divergir da primeira.
 */
interface SessionValue {
  api: ApiClient;
  profile: Profile;
  branches: BranchSummary[];
  /** Unidade em operação. */
  branch: BranchSummary;
  selectBranch: (branchId: string) => void;
  can: (permission: string) => boolean;
  signOut: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession precisa estar dentro de <SessionProvider>');
  return value;
}

const STORAGE_ORG = 'operator:org';
const STORAGE_BRANCH = 'operator:branch';

export const api = new ApiClient(
  window.location.origin,
  {
    async getRefreshToken() {
      return localStorage.getItem('operator:refresh');
    },
    async setRefreshToken(token) {
      if (token) localStorage.setItem('operator:refresh', token);
      else localStorage.removeItem('operator:refresh');
    },
  },
  // Sessão perdida no meio do uso: volta para o login em vez de deixar a tela
  // repetindo erro de autorização.
  () => window.location.reload(),
);

export function SessionProvider({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: (onSignedIn: () => void) => ReactNode;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [branchId, setBranchId] = useState<string | null>(
    () => localStorage.getItem(STORAGE_BRANCH),
  );
  const [checking, setChecking] = useState(true);

  const load = useCallback(async () => {
    const organizationSlug = localStorage.getItem(STORAGE_ORG);
    if (!organizationSlug) {
      setChecking(false);
      return;
    }
    try {
      if (!(await api.restoreSession())) {
        setChecking(false);
        return;
      }
      const [me, list] = await Promise.all([
        api.me(),
        api.listBranches(organizationSlug),
      ]);
      setProfile(me);
      setBranches(list);
      setBranchId((current) => {
        // Unidade guardada só vale se ainda estiver no escopo do usuário — o
        // gerente pode ter perdido acesso desde a última sessão.
        const stillValid = current && list.some((b) => b.id === current);
        return stillValid ? current : (list[0]?.id ?? null);
      });
    } catch {
      await api.clearSession();
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<SessionValue | null>(() => {
    const branch = branches.find((b) => b.id === branchId) ?? branches[0];
    if (!profile || !branch) return null;

    const permissions = new Set(profile.permissions);
    return {
      api,
      profile,
      branches,
      branch,
      selectBranch: (id) => {
        localStorage.setItem(STORAGE_BRANCH, id);
        setBranchId(id);
      },
      can: (permission) => permissions.has(permission),
      signOut: () => {
        void api.logout().finally(() => {
          localStorage.removeItem(STORAGE_ORG);
          localStorage.removeItem(STORAGE_BRANCH);
          window.location.reload();
        });
      },
    };
  }, [profile, branches, branchId]);

  if (checking) return <LoadingState label="Entrando…" />;
  if (!value) {
    return <>{fallback(() => void load())}</>;
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Guardado para que o próximo acesso já saiba em qual organização entrar. */
export function rememberOrganization(slug: string): void {
  localStorage.setItem(STORAGE_ORG, slug);
}
