import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, resetEnvCache } from '../src/config/env.js';

const BASE = { DATABASE_URL: 'postgresql://x@localhost/db' };
const SECRETS = {
  DATA_ENCRYPTION_KEY: 'chave-de-dados-com-mais-de-16-caracteres',
  PASSWORD_PEPPER: 'pepper-com-mais-de-16-caracteres',
};

describe('Configuração em produção', () => {
  afterEach(() => resetEnvCache());
  const load = (source: Record<string, string>) => {
    resetEnvCache();
    return loadEnv(source as NodeJS.ProcessEnv);
  };

  it('sobe com as duas chaves definidas', () => {
    expect(() => load({ ...BASE, ...SECRETS, NODE_ENV: 'production' })).not.toThrow();
  });

  it.each(['DATA_ENCRYPTION_KEY', 'PASSWORD_PEPPER'])('NÃO sobe sem %s: perderia o acesso ao que gravou no primeiro reinício', (missing) => {
    const source: Record<string, string> = { ...BASE, ...SECRETS, NODE_ENV: 'production' };
    delete source[missing];
    expect(() => load(source)).toThrow(new RegExp(missing));
  });

  it('recusa chave curta demais em produção', () => {
    expect(() => load({ ...BASE, ...SECRETS, DATA_ENCRYPTION_KEY: 'curta', NODE_ENV: 'production' })).toThrow(/DATA_ENCRYPTION_KEY/);
  });

  it('em desenvolvimento e teste continua opcional', () => {
    expect(() => load({ ...BASE, NODE_ENV: 'development' })).not.toThrow();
    expect(() => load({ ...BASE, NODE_ENV: 'test' })).not.toThrow();
  });

  it('a permissão de teste da verificação de link é recusada em produção', () => {
    expect(() => load({ ...BASE, ...SECRETS, NODE_ENV: 'production', PUBLIC_URL_PROBE_ALLOW_PRIVATE: 'true' })).toThrow(/PUBLIC_URL_PROBE_ALLOW_PRIVATE/);
    expect(load({ ...BASE, NODE_ENV: 'test', PUBLIC_URL_PROBE_ALLOW_PRIVATE: 'true' }).PUBLIC_URL_PROBE_ALLOW_PRIVATE).toBe(true);
    expect(load({ ...BASE, NODE_ENV: 'test' }).PUBLIC_URL_PROBE_ALLOW_PRIVATE).toBe(false);
  });

  it('valor inválido da permissão de teste é recusado (nada de "1" ou "yes")', () => {
    expect(() => load({ ...BASE, NODE_ENV: 'test', PUBLIC_URL_PROBE_ALLOW_PRIVATE: 'yes' })).toThrow();
  });
});
