import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- utilitário do launcher, em JS puro e sem tipos.
import { extractZip, ZipError } from '../../../scripts/unzip.mjs';

/**
 * EXTRATOR DE ZIP DO INSTALADOR.
 *
 * Existe porque este passo falhou na máquina de um usuário e as ferramentas do
 * sistema (`Expand-Archive`, `tar`) não se comportam igual entre Windows e
 * Linux — ou seja, era o trecho mais frágil da instalação e o único que não
 * dava para verificar antes de entregar. Agora dá.
 */
describe('Extrator de ZIP do instalador', () => {
  let workspace: string;
  let origem: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'unzip-test-'));
    origem = join(workspace, 'origem');
    await mkdir(join(origem, 'pgsql', 'bin'), { recursive: true });
    await mkdir(join(origem, 'pgsql', 'share'), { recursive: true });

    await writeFile(join(origem, 'pgsql', 'bin', 'initdb.exe'), 'binário de mentira');
    // Grande o bastante para o zip usar deflate de verdade, não só armazenar.
    await writeFile(join(origem, 'pgsql', 'share', 'grande.txt'), 'repetição '.repeat(20_000));
    await writeFile(join(origem, 'pgsql', 'share', 'acentuação.txt'), 'ção, ã, é');
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function zipar(nome: string): string {
    const destino = join(workspace, nome);
    execFileSync('zip', ['-qr', destino, 'pgsql'], { cwd: origem });
    return destino;
  }

  it('extrai a árvore inteira com o conteúdo intacto', async () => {
    const arquivo = zipar('completo.zip');
    const destino = join(workspace, 'saida-completa');

    const resultado = await extractZip(arquivo, destino);
    expect(resultado.files).toBe(3);

    expect(existsSync(join(destino, 'pgsql', 'bin', 'initdb.exe'))).toBe(true);
    // Arquivo comprimido precisa voltar byte a byte, não só existir.
    expect(await readFile(join(destino, 'pgsql', 'share', 'grande.txt'), 'utf8')).toBe(
      'repetição '.repeat(20_000),
    );
    expect(await readFile(join(destino, 'pgsql', 'share', 'acentuação.txt'), 'utf8')).toBe(
      'ção, ã, é',
    );
  });

  it('recusa entrada que tenta escapar da pasta de destino', async () => {
    // Zip Slip: um pacote hostil sobrescrevendo arquivo fora do destino. O
    // instalador baixa de uma URL configurável, então isto não é hipotético.
    const arquivo = join(workspace, 'slip.zip');
    const preparo = join(workspace, 'preparo');
    await mkdir(preparo, { recursive: true });
    await writeFile(join(preparo, 'inocente.txt'), 'ok');
    execFileSync('zip', ['-qr', arquivo, 'inocente.txt'], { cwd: preparo });
    // `zip` não cria entrada com "..", então a inserimos na marra.
    execFileSync('python3', [
      '-c',
      `import zipfile
z = zipfile.ZipFile(${JSON.stringify(arquivo)}, 'w')
z.writestr('../fugiu.txt', 'hostil')
z.close()`,
    ]);

    const destino = join(workspace, 'saida-slip');
    await expect(extractZip(arquivo, destino)).rejects.toThrow(ZipError);
    expect(existsSync(join(workspace, 'fugiu.txt'))).toBe(false);
  });

  it('recusa caminho absoluto dentro do pacote', async () => {
    const arquivo = join(workspace, 'absoluto.zip');
    execFileSync('python3', [
      '-c',
      `import zipfile
z = zipfile.ZipFile(${JSON.stringify(arquivo)}, 'w')
z.writestr('/etc/invasao.txt', 'hostil')
z.close()`,
    ]);

    await expect(extractZip(arquivo, join(workspace, 'saida-abs'))).rejects.toThrow(ZipError);
  });

  it('diz claramente quando o arquivo não é um ZIP', async () => {
    // O caso real: download interrompido deixa um arquivo truncado, e o erro
    // precisa apontar para isso em vez de para um detalhe de descompressão.
    const arquivo = join(workspace, 'truncado.zip');
    await writeFile(arquivo, 'isto não é um zip');

    await expect(extractZip(arquivo, join(workspace, 'saida-ruim'))).rejects.toThrow(
      /não parece um ZIP válido/,
    );
  });
});
