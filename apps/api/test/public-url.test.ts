import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  classifyHost,
  isPublicIp,
  normalizePublicBaseUrl,
  originFromHost,
  probePublicUrl,
  resolveShareBase,
} from '../src/modules/storefront/public-url.js';

describe('isPublicIp', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '200.147.67.142',
    '172.32.0.1', // logo acima do bloco privado 172.16/12
    '100.128.0.1', // logo acima do CGNAT 100.64/10
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8', // IPv4 público dentro de IPv6
  ])('%s é público', (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.10',
    '169.254.169.254', // metadados de nuvem
    '100.64.0.1',
    '100.127.255.255',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1', // mesma coisa, em hexadecimal
    '::ffff:a9fe:a9fe', // 169.254.169.254 em hexadecimal
    '2001:db8::1',
    '64:ff9b::7f00:1',
    'não-é-ip',
    '',
  ])('%s NÃO é público', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });
});

describe('classifyHost', () => {
  it.each([
    ['localhost', 'local'],
    ['app.localhost', 'local'],
    ['127.0.0.1', 'local'],
    ['[::1]', 'local'],
    ['192.168.0.10', 'lan'],
    ['10.0.0.5', 'lan'],
    ['100.101.102.103', 'lan'],
    ['loja-pc', 'lan'],
    ['impressora.local', 'lan'],
    ['servidor.lan', 'lan'],
    ['meu.home.arpa', 'lan'],
    ['8.8.8.8', 'public'],
    ['cardapio.minhaloja.com.br', 'public'],
    ['LOJA.COM.BR.', 'public'],
    ['minhaloja.vercel.app', 'public'],
  ])('%s => %s', (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

describe('normalizePublicBaseUrl', () => {
  it('aceita só a origem e descarta caminho, parâmetros e âncora', () => {
    expect(normalizePublicBaseUrl('https://Loja.com.br/')).toEqual({ ok: true, origin: 'https://loja.com.br' });
    expect(normalizePublicBaseUrl('https://loja.com.br/demo/centro?x=1#topo')).toEqual({
      ok: true,
      origin: 'https://loja.com.br',
    });
  });

  it('completa o https quando o dono cola só o domínio', () => {
    expect(normalizePublicBaseUrl('  cardapio.loja.com.br  ')).toEqual({
      ok: true,
      origin: 'https://cardapio.loja.com.br',
    });
  });

  it('preserva porta explícita e remove a porta padrão', () => {
    expect(normalizePublicBaseUrl('https://loja.com.br:8443')).toEqual({ ok: true, origin: 'https://loja.com.br:8443' });
    expect(normalizePublicBaseUrl('https://loja.com.br:443')).toEqual({ ok: true, origin: 'https://loja.com.br' });
  });

  it('converte domínio com acento para punycode', () => {
    const result = normalizePublicBaseUrl('https://cardápio.com.br');
    expect(result).toEqual({ ok: true, origin: 'https://xn--cardpio-kwa.com.br' });
  });

  it.each([
    ['http://loja.com.br', 'NOT_HTTPS'],
    ['ftp://loja.com.br', 'INVALID_URL'],
    ['javascript:alert(1)', 'INVALID_URL'],
    ['', 'INVALID_URL'],
    ['   ', 'INVALID_URL'],
    ['https://', 'INVALID_URL'],
    ['https://user:senha@loja.com.br', 'HAS_CREDENTIALS'],
    ['https://localhost:3000', 'NOT_PUBLIC'],
    ['https://192.168.0.5', 'NOT_PUBLIC'],
    ['https://10.0.0.1', 'NOT_PUBLIC'],
    ['https://loja-pc', 'NOT_PUBLIC'],
    ['https://impressora.local', 'NOT_PUBLIC'],
    ['https://2130706433', 'NOT_PUBLIC'], // 127.0.0.1 escrito como número
    ['https://0x7f.1', 'NOT_PUBLIC'], // idem, em hexadecimal
    ['https://[::1]', 'NOT_PUBLIC'],
    ['https://8.8.8.8', 'IP_LITERAL'],
    ['https://[2606:4700:4700::1111]', 'IP_LITERAL'],
  ])('recusa %s (%s)', (input, code) => {
    expect(normalizePublicBaseUrl(input)).toEqual({ ok: false, code });
  });
});

describe('originFromHost', () => {
  it('monta a origem a partir de protocolo e host', () => {
    expect(originFromHost('https', 'loja.com.br')).toBe('https://loja.com.br');
    expect(originFromHost('http', '192.168.0.5:3000')).toBe('http://192.168.0.5:3000');
  });

  it('com mais de um proxy, vale o primeiro host', () => {
    expect(originFromHost('https', 'a.com.br, b.com.br')).toBe('https://a.com.br');
  });

  it.each(['evil.com/path', 'a@b.com', 'a b.com', '', 'x\\y.com'])('recusa host malformado %j', (host) => {
    expect(originFromHost('https', host)).toBeNull();
  });

  it('sem host, null', () => {
    expect(originFromHost('https', undefined)).toBeNull();
  });
});

describe('resolveShareBase: ordem de prioridade', () => {
  const base = { configured: null, env: null, requestOrigin: null, lanAddress: '192.168.0.10', port: 3000 };

  it('1) o endereço cadastrado pelo dono vence tudo', () => {
    const r = resolveShareBase({
      ...base,
      configured: 'https://cardapio.loja.com.br',
      env: 'https://outro.com.br',
      requestOrigin: 'https://terceiro.com.br',
    });
    expect(r).toMatchObject({ origin: 'https://cardapio.loja.com.br', source: 'setting', reach: 'public', secure: true });
  });

  it('2) PUBLIC_BASE_URL público vence o endereço da requisição', () => {
    const r = resolveShareBase({ ...base, env: 'https://loja.vercel.app/', requestOrigin: 'https://terceiro.com.br' });
    expect(r).toMatchObject({ origin: 'https://loja.vercel.app', source: 'env', reach: 'public' });
  });

  it('3) painel aberto por um endereço público: usa esse endereço', () => {
    const r = resolveShareBase({ ...base, env: 'http://192.168.0.10:3000', requestOrigin: 'https://loja.com.br' });
    expect(r).toMatchObject({ origin: 'https://loja.com.br', source: 'request', reach: 'public' });
  });

  it('4) sem endereço público, PUBLIC_BASE_URL de rede local (o do launcher) e aviso de alcance', () => {
    const r = resolveShareBase({ ...base, env: 'http://192.168.0.10:3000', requestOrigin: 'http://localhost:3000' });
    expect(r).toMatchObject({ origin: 'http://192.168.0.10:3000', source: 'env', reach: 'lan', secure: false });
  });

  it('5) sem env, o IP da máquina na rede local', () => {
    const r = resolveShareBase({ ...base, requestOrigin: 'http://localhost:3000' });
    expect(r).toMatchObject({ origin: 'http://192.168.0.10:3000', source: 'lan', reach: 'lan' });
  });

  it('6) sem rede, localhost: só funciona nesta máquina', () => {
    const r = resolveShareBase({ ...base, lanAddress: null });
    expect(r).toMatchObject({ origin: 'http://localhost:3000', source: 'localhost', reach: 'local' });
  });

  it('PUBLIC_BASE_URL apontando para localhost é ignorado', () => {
    const r = resolveShareBase({ ...base, env: 'http://localhost:3000' });
    expect(r.source).toBe('lan');
  });

  it('PUBLIC_BASE_URL público em http segue válido, mas marcado como não seguro', () => {
    const r = resolveShareBase({ ...base, env: 'http://loja.com.br' });
    expect(r).toMatchObject({ source: 'env', reach: 'public', secure: false });
  });
});

describe('probePublicUrl', () => {
  const BRANCH = '11111111-1111-4111-8111-111111111111';
  let server: http.Server;
  let base: string;
  let mode: 'ok' | 'other' | 'html' | 'error' | 'redirect' | 'slow' | 'huge' | 'object' = 'ok';
  let lastRequest = { url: '', userAgent: '' };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastRequest = { url: req.url ?? '', userAgent: String(req.headers['user-agent']) };
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'https://outro.com.br/' });
        return res.end();
      }
      if (mode === 'error') {
        res.writeHead(502);
        return res.end('bad gateway');
      }
      if (mode === 'slow') return; // nunca responde
      res.writeHead(200, { 'content-type': mode === 'html' ? 'text/html' : 'application/json' });
      if (mode === 'html') return res.end('<html>Hospedagem parada</html>');
      if (mode === 'huge') return res.end(JSON.stringify([{ id: 'x'.repeat(200_000) }]));
      if (mode === 'object') return res.end(JSON.stringify({ id: BRANCH }));
      res.end(JSON.stringify([{ id: mode === 'ok' ? BRANCH : '22222222-2222-4222-8222-222222222222' }]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const probe = (options = {}) =>
    probePublicUrl(base, { organizationSlug: 'minha-loja', branchId: BRANCH }, { allowPrivateTargets: true, timeoutMs: 800, ...options });

  it('confirma quando o endereço devolve esta unidade', async () => {
    mode = 'ok';
    expect(await probe()).toEqual({ ok: true });
    expect(lastRequest.url).toBe('/v1/public/minha-loja/branches');
    expect(lastRequest.userAgent).toBe('plataforma-link-check');
  });

  it('o slug vai codificado no caminho (sem injeção de caminho)', async () => {
    mode = 'ok';
    await probePublicUrl(base, { organizationSlug: '../admin?x=1', branchId: BRANCH }, { allowPrivateTargets: true, timeoutMs: 800 });
    expect(lastRequest.url).toBe('/v1/public/..%2Fadmin%3Fx%3D1/branches');
  });

  it('outro sistema (ou outra unidade) respondendo no endereço: NOT_THIS_SYSTEM', async () => {
    mode = 'other';
    expect(await probe()).toEqual({ ok: false, reason: 'NOT_THIS_SYSTEM' });
  });

  it.each([
    ['html', 'INVALID_RESPONSE'],
    ['object', 'INVALID_RESPONSE'],
    ['huge', 'INVALID_RESPONSE'],
  ] as const)('resposta %s: %s', async (m, reason) => {
    mode = m;
    expect(await probe()).toEqual({ ok: false, reason });
  });

  it('erro HTTP é reportado com o status', async () => {
    mode = 'error';
    expect(await probe()).toEqual({ ok: false, reason: 'HTTP_STATUS', httpStatus: 502 });
  });

  it('NÃO segue redirecionamento (poderia levar a um alvo interno)', async () => {
    mode = 'redirect';
    expect(await probe()).toEqual({ ok: false, reason: 'REDIRECT', httpStatus: 302 });
  });

  it('servidor que não responde: TIMEOUT', async () => {
    mode = 'slow';
    expect(await probe({ timeoutMs: 300 })).toEqual({ ok: false, reason: 'TIMEOUT' });
  });

  it('porta fechada: UNREACHABLE', async () => {
    const closed = await probePublicUrl('http://127.0.0.1:1', { organizationSlug: 'x', branchId: BRANCH }, { allowPrivateTargets: true, timeoutMs: 800 });
    expect(closed).toEqual({ ok: false, reason: 'UNREACHABLE' });
  });

  describe('proteção contra uso do servidor para alcançar a rede interna (SSRF)', () => {
    it.each([
      'http://127.0.0.1:1',
      'http://[::1]:1',
      'http://10.0.0.1',
      'http://192.168.0.1',
      'http://169.254.169.254', // metadados de nuvem
      'http://[::ffff:127.0.0.1]:1',
      'http://2130706433:1', // 127.0.0.1 como número
    ])('recusa o alvo literal %s', async (target) => {
      const result = await probePublicUrl(target, { organizationSlug: 'x', branchId: BRANCH });
      expect(result).toEqual({ ok: false, reason: 'BLOCKED_ADDRESS' });
    });

    it('recusa um NOME que resolve para endereço interno (localhost)', async () => {
      const result = await probePublicUrl(`http://localhost:${new URL(base).port}`, { organizationSlug: 'x', branchId: BRANCH });
      expect(result).toEqual({ ok: false, reason: 'BLOCKED_ADDRESS' });
    });

    it('sem a permissão de teste, o servidor local do próprio teste é inalcançável por design', async () => {
      mode = 'ok';
      const result = await probePublicUrl(base, { organizationSlug: 'minha-loja', branchId: BRANCH });
      expect(result).toEqual({ ok: false, reason: 'BLOCKED_ADDRESS' });
    });
  });
});
