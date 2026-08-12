#!/usr/bin/env node
/**
 * LAUNCHER — o programa que o dono do restaurante abre.
 *
 * Objetivo: clique duplo e o sistema está no ar. Sem terminal, sem Docker, sem
 * instalar banco de dados à parte.
 *
 * O que ele faz, em ordem:
 *   1. garante um PostgreSQL utilizável (empacotado no Windows, do sistema no
 *      Linux/macOS);
 *   2. cria o cluster e o banco na primeira execução;
 *   3. aplica migrações e a massa demonstrativa;
 *   4. sobe a API;
 *   5. descobre o IP da máquina na rede local — o celular do cliente NÃO
 *      alcança "localhost", então o link do cardápio precisa do IP real;
 *   6. abre o navegador no painel do operador.
 *
 * Está em Node, e não num .bat, por três razões: é testável fora do Windows,
 * roda igual nos três sistemas, e o .bat vira uma casca de duas linhas onde
 * quase nada pode dar errado.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME = join(ROOT, 'runtime');
const PGROOT = join(RUNTIME, 'pgsql');
const PGDATA = join(RUNTIME, 'pgdata');
const SECRETS_FILE = join(RUNTIME, 'secrets.json');
const API_DIR = join(ROOT, 'apps', 'api');

const PGPORT = Number(process.env.PGPORT ?? 5433);
const APIPORT = Number(process.env.PORT ?? 3000);
const DBNAME = 'plataforma';
const IS_WINDOWS = process.platform === 'win32';

/** Binários oficiais do PostgreSQL para Windows, sem instalador. */
const PG_WINDOWS_URL =
  process.env.PG_WINDOWS_URL ??
  'https://get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip';

const log = (msg) => console.log(msg);
const step = (msg) => console.log(`\n==> ${msg}`);

function fail(message, hint) {
  console.error(`\nERRO: ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dependências
// ---------------------------------------------------------------------------

/**
 * Instala as dependências na primeira execução.
 *
 * Mora aqui, e não no .bat, por uma razão concreta: no Windows, `pnpm` é um
 * script `.cmd`, e chamá-lo de dentro de um bloco de batch encerrava o arquivo
 * sem executar o resto — sem mensagem de erro nenhuma. Em Node o encadeamento é
 * explícito e o mesmo código roda nos três sistemas.
 */
function ensureDependencies() {
  if (existsSync(join(ROOT, 'node_modules', '.pnpm'))) return;

  step('Preparando o sistema pela primeira vez. Isso leva alguns minutos');

  const pnpm = spawnSync(IS_WINDOWS ? 'pnpm.cmd' : 'pnpm', ['install'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });
  if (pnpm.status === 0) return;

  // pnpm ausente: instala e tenta de novo, uma vez.
  log('    Instalando o gerenciador de pacotes...');
  const install = spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', ['install', '-g', 'pnpm'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });
  if (install.status !== 0) {
    fail('não foi possível instalar o gerenciador de pacotes.', 'Verifique a conexão com a internet.');
  }

  const retry = spawnSync(IS_WINDOWS ? 'pnpm.cmd' : 'pnpm', ['install'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });
  if (retry.status !== 0) fail('não foi possível preparar o sistema.');
}

/**
 * Compila o painel e o cardápio se ainda não estiverem compilados.
 *
 * Os `dist/` não são versionados, então num clone limpo eles não existem — e
 * sem eles a API sobe normalmente mas /admin devolve nada. Compilar aqui é o
 * que faz o primeiro clique terminar numa tela em vez de numa página em branco.
 */
function ensureWebBuilds() {
  const targets = [
    { name: '@plataforma/web-customer', dist: join(ROOT, 'apps', 'web-customer', 'dist') },
    { name: '@plataforma/web-operator', dist: join(ROOT, 'apps', 'web-operator', 'dist') },
  ].filter((target) => !existsSync(join(target.dist, 'index.html')));

  if (targets.length === 0) return;

  step('Preparando as telas');
  for (const target of targets) {
    const result = spawnSync(
      IS_WINDOWS ? 'pnpm.cmd' : 'pnpm',
      ['--filter', target.name, 'build'],
      { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS },
    );
    if (result.status !== 0) fail(`não foi possível preparar as telas (${target.name}).`);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

/** Caminho dos binários (bin/) do PostgreSQL, ou null se não houver. */
function findSystemPostgres() {
  const candidates = [
    process.env.PGBIN,
    '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/15/bin',
    '/usr/local/opt/postgresql@16/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(join(dir, IS_WINDOWS ? 'initdb.exe' : 'initdb'))) return dir;
  }
  // Última tentativa: initdb no PATH.
  const probe = spawnSync(IS_WINDOWS ? 'where' : 'which', ['initdb'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const first = probe.stdout.trim().split(/\r?\n/)[0];
    if (first) return dirname(first);
  }
  return null;
}

async function downloadPostgresForWindows() {
  const bundled = join(PGROOT, 'bin');
  if (existsSync(join(bundled, 'initdb.exe'))) return bundled;

  step('Baixando o banco de dados (só na primeira execução, ~130 MB)');
  log('    Isso leva alguns minutos. Nas próximas vezes começa direto.');

  const zipPath = join(tmpdir(), 'postgres-bin.zip');
  const response = await fetch(PG_WINDOWS_URL).catch((error) => {
    fail(
      `não foi possível baixar o banco de dados: ${error.message}`,
      'Verifique a conexão com a internet. O download só é necessário uma vez.',
    );
  });
  if (!response?.ok) {
    fail(
      `o download do banco de dados falhou (HTTP ${response?.status}).`,
      'Verifique a conexão com a internet e tente novamente.',
    );
  }

  await mkdir(RUNTIME, { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));

  step('Instalando o banco de dados');
  // Expand-Archive vem no Windows desde o PowerShell 5; não exige nada extra.
  const unzip = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${RUNTIME}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  if (unzip.status !== 0) fail('não foi possível descompactar o banco de dados.');
  await rm(zipPath, { force: true });

  if (!existsSync(join(bundled, 'initdb.exe'))) {
    fail('o pacote do banco de dados veio incompleto.', 'Apague a pasta runtime/ e tente de novo.');
  }
  return bundled;
}

async function ensurePostgresBinaries() {
  if (IS_WINDOWS) return downloadPostgresForWindows();

  const system = findSystemPostgres();
  if (system) return system;
  fail(
    'PostgreSQL não encontrado neste sistema.',
    process.platform === 'darwin'
      ? 'Instale com: brew install postgresql@16'
      : 'Instale com: sudo apt install postgresql-16',
  );
}

function pgBin(binDir, name) {
  return join(binDir, IS_WINDOWS ? `${name}.exe` : name);
}

/**
 * O PostgreSQL recusa rodar como root. No Windows isso não acontece; no
 * Linux/macOS acontece se o usuário abrir com sudo — e neste caso delegamos ao
 * usuário `postgres`, exatamente como o script de desenvolvimento já fazia.
 */
const NEEDS_PRIVILEGE_DROP =
  !IS_WINDOWS &&
  typeof process.getuid === 'function' &&
  process.getuid() === 0 &&
  spawnSync('id', ['postgres'], { stdio: 'ignore' }).status === 0;

function pgSpawn(binDir, name, args, opts = {}) {
  const executable = pgBin(binDir, name);
  if (!NEEDS_PRIVILEGE_DROP) {
    return spawnSync(executable, args, { stdio: 'inherit', ...opts });
  }
  const quoted = [executable, ...args].map((part) => `'${String(part).replace(/'/g, `'\\''`)}'`);
  return spawnSync('su', ['postgres', '-c', quoted.join(' ')], { stdio: 'inherit', ...opts });
}

async function ensureCluster(binDir) {
  if (existsSync(join(PGDATA, 'PG_VERSION'))) return;

  step('Preparando o banco de dados (só na primeira execução)');
  await mkdir(PGDATA, { recursive: true });
  if (NEEDS_PRIVILEGE_DROP) {
    spawnSync('chown', ['postgres:postgres', PGDATA], { stdio: 'ignore' });
    spawnSync('chmod', ['700', PGDATA], { stdio: 'ignore' });
  }
  // -A trust: o banco só escuta em localhost e é de uso local do restaurante.
  const result = pgSpawn(binDir, 'initdb', ['-D', PGDATA, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8']);
  if (result.status !== 0) fail('não foi possível preparar o banco de dados.');
}

/** Dentro do PGDATA porque é o único diretório que o usuário do banco possui. */
const PG_LOG = join(PGDATA, 'server.log');

function startPostgres(binDir) {
  step('Iniciando o banco de dados');
  const result = pgSpawn(binDir, 'pg_ctl', ['-D', PGDATA, '-l', PG_LOG, '-w', 'start', '-o', `-p ${PGPORT}`]);
  if (result.status !== 0) {
    fail(
      'o banco de dados não subiu.',
      `Veja o detalhe em ${PG_LOG}. Se outro programa estiver usando a porta ${PGPORT}, feche-o e tente de novo.`,
    );
  }
}

function stopPostgres(binDir) {
  pgSpawn(binDir, 'pg_ctl', ['-D', PGDATA, '-m', 'fast', 'stop'], { stdio: 'ignore' });
}

function ensureDatabase(binDir) {
  const exists = pgSpawn(
    binDir,
    'psql',
    ['-h', 'localhost', '-p', String(PGPORT), '-U', 'postgres', '-tAc',
     `SELECT 1 FROM pg_database WHERE datname = '${DBNAME}'`],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  if (exists.stdout?.trim() === '1') return;

  const created = pgSpawn(binDir, 'createdb', ['-h', 'localhost', '-p', String(PGPORT), '-U', 'postgres', DBNAME]);
  if (created.status !== 0) fail('não foi possível criar o banco de dados.');
}

// ---------------------------------------------------------------------------
// Segredos
// ---------------------------------------------------------------------------

/**
 * Gera os segredos UMA vez e os reusa sempre.
 *
 * Persistir não é detalhe de implementação, é requisito:
 *   - o pepper entra no hash da senha; trocá-lo tranca todo mundo para fora;
 *   - a chave do JWT assina a sessão; trocá-la desloga o operador a cada
 *     reinicialização (é exatamente o motivo pelo qual TokenService recusa
 *     chave efêmera em produção);
 *   - a chave de dados decifra a chave Pix já gravada.
 */
async function ensureSecrets() {
  try {
    await access(SECRETS_FILE, constants.R_OK);
    return JSON.parse(await readFile(SECRETS_FILE, 'utf8'));
  } catch {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const secrets = {
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      PASSWORD_PEPPER: randomBytes(32).toString('base64'),
      JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      JWT_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    await mkdir(RUNTIME, { recursive: true });
    await writeFile(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    return secrets;
  }
}

// ---------------------------------------------------------------------------
// Rede
// ---------------------------------------------------------------------------

/**
 * IP desta máquina na rede local.
 *
 * O celular do cliente está no Wi-Fi do restaurante e não resolve "localhost":
 * o QR code precisa apontar para 192.168.x.x (ou equivalente).
 */
export function lanAddress() {
  const interfaces = networkInterfaces();
  const candidates = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // Interfaces virtuais (Docker, WSL, VPN) costumam não ser alcançáveis
      // pelo celular do cliente; ficam por último.
      const virtual = /^(docker|br-|veth|vEthernet|VMware|VirtualBox|utun|tun)/i.test(name);
      candidates.push({ address: address.address, virtual });
    }
  }

  const preferred = candidates.find((c) => !c.virtual) ?? candidates[0];
  return preferred?.address ?? null;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function runNodeScript(script, env, label) {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', script], {
    cwd: API_DIR,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`falha ao ${label}.`);
}

async function waitForApi(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/public/demo/branches`);
      if (response.ok) return true;
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : IS_WINDOWS ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

// ---------------------------------------------------------------------------

async function main() {
  const noBrowser = process.argv.includes('--no-browser');
  const exitAfterBoot = process.argv.includes('--smoke');

  console.log('\n=======================================');
  console.log('  Plataforma de Pedidos');
  console.log('=======================================');

  ensureDependencies();
  ensureWebBuilds();

  const binDir = await ensurePostgresBinaries();
  await ensureCluster(binDir);
  startPostgres(binDir);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    step('Encerrando');
    stopPostgres(binDir);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  ensureDatabase(binDir);

  const secrets = await ensureSecrets();
  const lan = lanAddress();
  const env = {
    ...process.env,
    ...secrets,
    NODE_ENV: 'production',
    PORT: String(APIPORT),
    DATABASE_URL: `postgresql://postgres@localhost:${PGPORT}/${DBNAME}`,
    MEDIA_STORAGE_DIR: join(RUNTIME, 'media'),
    // O servidor monta o link do QR code a partir daqui, para que o endereço
    // impresso neste console e o do painel sejam sempre o mesmo.
    PUBLIC_BASE_URL: `http://${lan ?? 'localhost'}:${APIPORT}`,
  };

  step('Atualizando o banco de dados');
  runNodeScript(join(API_DIR, 'src', 'db', 'migrate.ts'), env, 'atualizar o banco de dados');
  runNodeScript(join(API_DIR, 'src', 'db', 'seed.ts'), env, 'preparar o cardápio inicial');

  step('Iniciando o sistema');
  const api = spawn(process.execPath, ['--import', 'tsx/esm', join(API_DIR, 'src', 'main.ts')], {
    cwd: API_DIR,
    env,
    stdio: 'inherit',
  });
  api.on('exit', (code) => {
    if (!stopping && code !== 0) {
      console.error(`\nO sistema encerrou inesperadamente (código ${code}).`);
      stopPostgres(binDir);
      process.exit(code ?? 1);
    }
  });

  if (!(await waitForApi(APIPORT))) {
    api.kill();
    stopPostgres(binDir);
    fail('o sistema não respondeu a tempo.', `Veja o detalhe em ${PG_LOG}.`);
  }

  const adminUrl = `http://localhost:${APIPORT}/admin`;
  const menuUrl = `${env.PUBLIC_BASE_URL}/demo/centro`;

  console.log('\n=======================================');
  console.log('  Sistema no ar');
  console.log('=======================================');
  console.log(`\n  Painel do operador:  ${adminUrl}`);
  console.log(`  Cardápio do cliente: ${menuUrl}`);
  if (!lan) {
    console.log('\n  Aviso: não foi possível descobrir o IP desta máquina na rede.');
    console.log('  Os clientes só conseguirão abrir o cardápio a partir deste computador.');
  }
  console.log('\n  Entrar como: admin@demo.local / restaurante123');
  console.log('\n  Para encerrar, feche esta janela.\n');

  if (!noBrowser) openBrowser(adminUrl);

  if (exitAfterBoot) {
    api.kill();
    stopPostgres(binDir);
    console.log('Verificação concluída.');
    process.exit(0);
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
