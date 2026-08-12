import { createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/**
 * Extrator de ZIP em Node puro.
 *
 * Por que não delegar ao sistema: `Expand-Archive` do PowerShell falhou na
 * máquina de um usuário sem dizer por quê, e o `tar` que lê zip só existe no
 * Windows recente (no Linux é GNU tar, que não lê zip) — ou seja, o passo mais
 * frágil da instalação era justamente o único que eu não conseguia testar.
 *
 * Aqui o comportamento é o mesmo nos três sistemas e cabe num teste.
 *
 * Escopo deliberado: ZIP clássico, métodos "armazenado" (0) e "deflate" (8),
 * que é o que os binários do PostgreSQL usam. Sem ZIP64 (desnecessário abaixo
 * de 4 GB), sem criptografia, sem multi-volume.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {}

/** Localiza o registro final (EOCD), que aponta para o diretório central. */
function findEndOfCentralDirectory(buffer) {
  // Ele fica no fim, mas pode ter até 64 KB de comentário depois — por isso a
  // busca é de trás para frente.
  const start = Math.max(0, buffer.length - (MAX_COMMENT + 22));
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      return {
        entryCount: buffer.readUInt16LE(i + 10),
        centralSize: buffer.readUInt32LE(i + 12),
        centralOffset: buffer.readUInt32LE(i + 16),
      };
    }
  }
  throw new ZipError('arquivo não parece um ZIP válido (registro final ausente)');
}

function readCentralDirectory(buffer, eocd) {
  const entries = [];
  let offset = eocd.centralOffset;

  for (let i = 0; i < eocd.entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`entrada ${i + 1} do índice está corrompida`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    entries.push({
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      externalAttributes: buffer.readUInt32LE(offset + 38),
      localOffset: buffer.readUInt32LE(offset + 42),
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Resolve o destino de uma entrada, recusando escapes.
 *
 * Um zip pode conter `../../algo` e sobrescrever arquivo fora da pasta de
 * destino (Zip Slip). Só extraímos o que permanece dentro do destino.
 */
function safeDestination(destination, entryName) {
  const cleaned = entryName.replace(/\\/g, '/');
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) {
    throw new ZipError(`entrada com caminho absoluto recusada: ${entryName}`);
  }
  const target = normalize(join(destination, cleaned));
  const root = normalize(destination.endsWith(sep) ? destination : destination + sep);
  if (!target.startsWith(root)) {
    throw new ZipError(`entrada tentando escapar do destino: ${entryName}`);
  }
  return target;
}

/** Extrai `zipPath` dentro de `destination`. */
export async function extractZip(zipPath, destination) {
  const handle = await open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);

    const eocd = findEndOfCentralDirectory(buffer);
    const entries = readCentralDirectory(buffer, eocd);

    let files = 0;
    for (const entry of entries) {
      const target = safeDestination(destination, entry.name);

      if (entry.name.endsWith('/')) {
        await mkdir(target, { recursive: true });
        continue;
      }

      // O cabeçalho local repete nome e extras com tamanhos próprios; os dados
      // começam depois deles, não depois dos tamanhos do índice central.
      const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
      const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);

      await mkdir(dirname(target), { recursive: true });

      if (entry.method === 0) {
        await pipeline(Readable.from(data), createWriteStream(target));
      } else if (entry.method === 8) {
        await pipeline(Readable.from(data), createInflateRaw(), createWriteStream(target));
      } else {
        throw new ZipError(`método de compressão ${entry.method} não suportado (${entry.name})`);
      }

      // Bit de execução vindo do zip (Unix). No Windows é ignorado pelo SO.
      const unixMode = (entry.externalAttributes >>> 16) & 0o777;
      if (unixMode && process.platform !== 'win32') {
        await handleChmod(target, unixMode);
      }

      files++;
    }

    return { files, entries: entries.length };
  } finally {
    await handle.close();
  }
}

async function handleChmod(target, mode) {
  const { chmod } = await import('node:fs/promises');
  await chmod(target, mode);
}
