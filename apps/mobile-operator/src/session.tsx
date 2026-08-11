import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { ApiClient, type Profile, type TokenStorage } from '@plataforma/client';

/**
 * Armazenamento do refresh token.
 *
 * Keychain (iOS) / Keystore (Android) via expo-secure-store, com
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: cifrado pelo hardware e fora do backup do
 * iCloud/Google. NUNCA AsyncStorage — lá o token fica em texto plano, legível
 * em aparelho com root/jailbreak (docs/07 §3).
 *
 * O ACCESS token nunca é persistido: vive só em memória, dentro do ApiClient.
 */
const REFRESH_KEY = 'plataforma.operator.refresh_token';
const ORG_KEY = 'plataforma.operator.organization';

const secureStorage: TokenStorage = {
  async getRefreshToken() {
    return SecureStore.getItemAsync(REFRESH_KEY);
  },
  async setRefreshToken(token) {
    if (token === null) {
      await SecureStore.deleteItemAsync(REFRESH_KEY);
      return;
    }
    await SecureStore.setItemAsync(REFRESH_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
};

const API_BASE_URL =
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ??
  'http://localhost:3000';

interface SessionValue {
  api: ApiClient;
  profile: Profile | null;
  /** Identificador da franquia usado no login — não é credencial nem segredo. */
  organizationSlug: string | null;
  isReady: boolean;
  isAuthenticated: boolean;
  /** Verificação de conveniência para ESCONDER interface. O servidor decide. */
  can: (permission: string) => boolean;
  refreshProfile: () => Promise<void>;
  signIn: (input: { organizationSlug: string; email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [organizationSlug, setOrganizationSlug] = useState<string | null>(null);
  const [isReady, setReady] = useState(false);

  const api = useMemo(
    () => new ApiClient(API_BASE_URL, secureStorage, () => setProfile(null)),
    [],
  );

  const refreshProfile = useCallback(async () => {
    try {
      setProfile(await api.me());
    } catch {
      setProfile(null);
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await api.restoreSession();
      if (restored && !cancelled) {
        await refreshProfile();
        setOrganizationSlug(await SecureStore.getItemAsync(ORG_KEY));
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, refreshProfile]);

  const signIn = useCallback(
    async (input: { organizationSlug: string; email: string; password: string }) => {
      await api.loginStaff(input);
      await SecureStore.setItemAsync(ORG_KEY, input.organizationSlug);
      setOrganizationSlug(input.organizationSlug);
      await refreshProfile();
    },
    [api, refreshProfile],
  );

  const signOut = useCallback(async () => {
    await api.logout();
    await SecureStore.deleteItemAsync(ORG_KEY);
    setProfile(null);
    setOrganizationSlug(null);
  }, [api]);

  const value = useMemo<SessionValue>(
    () => ({
      api,
      profile,
      organizationSlug,
      isReady,
      isAuthenticated: profile !== null,
      // Esconder o botão evita que o operador tente algo que vai falhar.
      // NÃO é controle de acesso: as permissões chegam do servidor a cada
      // `me()` e são reconferidas em toda requisição (item 10).
      can: (permission: string) => profile?.permissions.includes(permission) ?? false,
      refreshProfile,
      signIn,
      signOut,
    }),
    [api, profile, organizationSlug, isReady, refreshProfile, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession precisa estar dentro de <SessionProvider>');
  return value;
}
