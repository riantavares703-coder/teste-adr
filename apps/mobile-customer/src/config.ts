import Constants from 'expo-constants';

/**
 * Configuração do build.
 *
 * Cada marca publica o próprio aplicativo, então o identificador da franquia
 * acompanha o binário — não é digitado pelo cliente nem enviado em header.
 *
 * O que NÃO entra aqui: nada secreto. `app.json` vai para dentro do bundle e
 * qualquer pessoa consegue lê-lo com um descompactador. Chave de API, token de
 * WhatsApp e credencial de PSP vivem no servidor (docs/07 §4).
 */
interface AppExtra {
  apiBaseUrl?: string;
  organizationSlug?: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as AppExtra;

export const API_BASE_URL = extra.apiBaseUrl ?? 'http://localhost:3000';
export const ORGANIZATION_SLUG = extra.organizationSlug ?? 'acme';
