import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

/**
 * ENDEREÇO PÚBLICO DO CARDÁPIO.
 *
 * O link e o QR code só servem se o celular do cliente alcançar o endereço de
 * ONDE ELE ESTIVER — em casa, no 4G. Um endereço de rede local (192.168.x.x)
 * só funciona dentro do Wi-Fi da loja; este módulo sabe distinguir os dois, e
 * verificar que um endereço informado pelo dono realmente leva a este sistema.
 */

export type Reach = 'public' | 'lan' | 'local';

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addSubnet('0.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
LOOPBACK.addAddress('::', 'ipv6');

/** Tudo que NÃO é endereço de internet pública (além do loopback acima). */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8], // privado
  ['100.64.0.0', 10], // CGNAT / Tailscale: não é alcançável de fora
  ['169.254.0.0', 16], // link-local (inclui metadados de nuvem 169.254.169.254)
  ['172.16.0.0', 12], // privado
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentação
  ['192.168.0.0', 16], // privado
  ['198.18.0.0', 15], // teste de rede
  ['198.51.100.0', 24], // documentação
  ['203.0.113.0', 24], // documentação
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservado (inclui 255.255.255.255)
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['fc00::', 7], // ULA (privado)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentação
  ['64:ff9b::', 96], // NAT64: embute um IPv4 que não validamos aqui
  ['2002::', 16], // 6to4: idem
  ['100::', 64], // descarte
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/** `::ffff:a.b.c.d` — IPv4 dentro de IPv6 — é avaliado como o IPv4 que contém. */
function unmap(address: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return { address: mapped[1]!, family: 'ipv4' };
  return { address, family: isIP(address) === 6 ? 'ipv6' : 'ipv4' };
}

export function isLoopbackIp(address: string): boolean {
  const { address: a, family } = unmap(address);
  return LOOPBACK.check(a, family);
}

/** Verdadeiro só para endereço roteável na internet pública. */
export function isPublicIp(address: string): boolean {
  if (isIP(address) === 0) return false;
  const { address: a, family } = unmap(address);
  return !LOOPBACK.check(a, family) && !NON_PUBLIC.check(a, family);
}

const PRIVATE_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.internal',
  '.intranet',
  '.corp',
  '.private',
  '.localdomain',
  '.home.arpa',
];

/** Classifica um HOSTNAME (sem porta) pelo alcance que ele tem. */
export function classifyHost(rawHost: string): Reach {
  let host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (isIP(host) !== 0) {
    if (isLoopbackIp(host)) return 'local';
    return isPublicIp(host) ? 'public' : 'lan';
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local';
  // Nome sem ponto ("loja-pc") só existe dentro da rede local.
  if (!host.includes('.')) return 'lan';
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'lan';
  return 'public';
}

export type NormalizeError =
  | 'INVALID_URL'
  | 'NOT_HTTPS'
  | 'HAS_CREDENTIALS'
  | 'NOT_PUBLIC'
  | 'IP_LITERAL';

export const NORMALIZE_MESSAGE: Record<NormalizeError, string> = {
  INVALID_URL: 'Endereço inválido. Exemplo: https://cardapio.minhaloja.com.br',
  NOT_HTTPS: 'Use um endereço seguro, começando com https://.',
  HAS_CREDENTIALS: 'O endereço não pode conter usuário ou senha.',
  NOT_PUBLIC:
    'Esse endereço só funciona dentro da sua rede. Informe um endereço público da internet.',
  IP_LITERAL: 'Use um nome de site (domínio), e não um número de IP.',
};

/**
 * Valida o que o dono digitou e devolve só a ORIGEM (`https://host[:porta]`).
 *
 * Caminho, parâmetros e âncora são descartados de propósito: quem cola o link
 * completo do cardápio ("https://loja.com/demo/centro") obtém o endereço certo
 * em vez de um erro. Exige HTTPS porque por esse endereço passam pedidos e
 * pagamentos.
 */
export function normalizePublicBaseUrl(
  input: string,
): { ok: true; origin: string } | { ok: false; code: NormalizeError } {
  let text = input.trim();
  if (!text) return { ok: false, code: 'INVALID_URL' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: 'INVALID_URL' };
  }
  if (url.protocol === 'http:') return { ok: false, code: 'NOT_HTTPS' };
  if (url.protocol !== 'https:') return { ok: false, code: 'INVALID_URL' };
  if (url.username || url.password) return { ok: false, code: 'HAS_CREDENTIALS' };
  if (!url.hostname) return { ok: false, code: 'INVALID_URL' };

  if (classifyHost(url.hostname) !== 'public') return { ok: false, code: 'NOT_PUBLIC' };
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return { ok: false, code: 'IP_LITERAL' };
  return { ok: true, origin: url.origin };
}

/** Origem a partir de `protocolo` + `host[:porta]` de uma requisição; `null` se ilegível. */
export function originFromHost(protocol: string, hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  // Pode vir lista ("a.com, b.com") quando há mais de um proxy: vale o primeiro.
  const first = hostHeader.split(',')[0]!.trim();
  if (!first || /[\s/@\\]/.test(first)) return null;
  const scheme = protocol === 'https' ? 'https' : 'http';
  try {
    return new URL(`${scheme}://${first}`).origin;
  } catch {
    return null;
  }
}

export interface ShareBaseInput {
  /** Endereço salvo pelo dono para esta unidade (já normalizado). */
  configured: string | null;
  /** Variável PUBLIC_BASE_URL do servidor, como veio. */
  env: string | null;
  /** Origem pela qual o painel está sendo acessado agora. */
  requestOrigin: string | null;
  lanAddress: string | null;
  port: number;
}

export type ShareSource = 'setting' | 'env' | 'request' | 'lan' | 'localhost';

export interface ShareBase {
  origin: string;
  source: ShareSource;
  reach: Reach;
  secure: boolean;
}

function parseOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}

function describe(origin: string, source: ShareSource): ShareBase {
  const url = new URL(origin);
  return {
    origin,
    source,
    reach: classifyHost(url.hostname),
    secure: url.protocol === 'https:',
  };
}

/**
 * Escolhe o endereço-base do link, do mais confiável ao menos:
 *
 *  1. o endereço que o dono cadastrou para a unidade;
 *  2. PUBLIC_BASE_URL, se for público (hospedagem na internet);
 *  3. o endereço pelo qual o próprio painel está aberto, se for público;
 *  4. PUBLIC_BASE_URL de rede local (o que o launcher define);
 *  5. o IP desta máquina na rede local;
 *  6. localhost (só funciona nesta máquina).
 */
export function resolveShareBase(input: ShareBaseInput): ShareBase {
  if (input.configured) return describe(input.configured, 'setting');

  const env = parseOrigin(input.env);
  const envReach = env ? classifyHost(new URL(env).hostname) : null;
  if (env && envReach === 'public') return describe(env, 'env');

  if (input.requestOrigin && classifyHost(new URL(input.requestOrigin).hostname) === 'public') {
    return describe(input.requestOrigin, 'request');
  }

  if (env && envReach === 'lan') return describe(env, 'env');
  if (input.lanAddress) return describe(`http://${input.lanAddress}:${input.port}`, 'lan');
  return describe(`http://localhost:${input.port}`, 'localhost');
}

// ---------------------------------------------------------------------------
// Verificação: o endereço informado realmente leva a ESTE sistema?
// ---------------------------------------------------------------------------

export type ProbeFailure =
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'BLOCKED_ADDRESS'
  | 'TLS'
  | 'REDIRECT'
  | 'HTTP_STATUS'
  | 'INVALID_RESPONSE'
  | 'NOT_THIS_SYSTEM';

export type ProbeResult = { ok: true } | { ok: false; reason: ProbeFailure; httpStatus?: number };

export interface ProbeOptions {
  timeoutMs?: number;
  /** Só para testes: permite alvos de rede local. Recusado em produção (ver env.ts). */
  allowPrivateTargets?: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * `lookup` que valida o IP REAL da conexão.
 *
 * Verificar o nome antes e conectar depois deixaria uma brecha (DNS rebinding:
 * o nome aponta para um IP público na checagem e para 127.0.0.1 na conexão). Aqui
 * a checagem acontece no momento exato em que o endereço é escolhido.
 */
function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (...args: unknown[]) => void,
  ): void => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses as LookupAddress[];
      if (list.length === 0) return callback(new Error('ENOTFOUND'));
      if (!allowPrivate && list.some((entry) => !isPublicIp(entry.address))) {
        const blocked = new Error('BLOCKED_ADDRESS');
        (blocked as NodeJS.ErrnoException).code = 'BLOCKED_ADDRESS';
        return callback(blocked);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/**
 * Confere que `${origin}/v1/public/<org>/branches` responde e inclui esta
 * unidade. Devolve só um veredito — nunca o conteúdo da resposta.
 *
 * Proteções, porque o endereço vem de um usuário e o servidor faz a chamada:
 * IPs privados/loopback/metadados recusados no momento da conexão, sem seguir
 * redirecionamentos, corpo limitado e tempo máximo.
 */
export function probePublicUrl(
  origin: string,
  expected: { organizationSlug: string; branchId: string },
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 6000;
  const allowPrivate = options.allowPrivateTargets === true;

  let target: URL;
  try {
    target = new URL(`/v1/public/${encodeURIComponent(expected.organizationSlug)}/branches`, origin);
  } catch {
    return Promise.resolve({ ok: false, reason: 'UNREACHABLE' });
  }
  // O Node não chama `lookup` quando o host já é um IP literal: sem esta checagem
  // explícita, "https://127.0.0.1" passaria direto pela proteção.
  const literal = target.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0 && !allowPrivate && !isPublicIp(literal)) {
    return Promise.resolve({ ok: false, reason: 'BLOCKED_ADDRESS' });
  }
  const client = target.protocol === 'https:' ? https : http;

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = client.request(
      target,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'plataforma-link-check' },
        timeout: timeoutMs,
        lookup: guardedLookup(allowPrivate) as never,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          return finish({ ok: false, reason: 'REDIRECT', httpStatus: status });
        }
        if (status !== 200) {
          response.resume();
          return finish({ ok: false, reason: 'HTTP_STATUS', httpStatus: status });
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            response.destroy();
            return finish({ ok: false, reason: 'INVALID_RESPONSE' });
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            if (!Array.isArray(body)) return finish({ ok: false, reason: 'INVALID_RESPONSE' });
            const found = body.some(
              (item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === expected.branchId,
            );
            finish(found ? { ok: true } : { ok: false, reason: 'NOT_THIS_SYSTEM' });
          } catch {
            finish({ ok: false, reason: 'INVALID_RESPONSE' });
          }
        });
        response.on('error', () => finish({ ok: false, reason: 'UNREACHABLE' }));
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish({ ok: false, reason: 'TIMEOUT' });
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? '';
      if (code === 'BLOCKED_ADDRESS' || error.message === 'BLOCKED_ADDRESS') {
        return finish({ ok: false, reason: 'BLOCKED_ADDRESS' });
      }
      if (/CERT|SSL|TLS|ERR_TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/i.test(code)) {
        return finish({ ok: false, reason: 'TLS' });
      }
      finish({ ok: false, reason: 'UNREACHABLE' });
    });
    request.end();
  });
}
