import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 — 48 bits de timestamp em milissegundos + 74 bits aleatórios.
 *
 * ADR-0010: chaves ordenáveis no tempo (localidade de índice) e não
 * enumeráveis. `crypto.randomUUID()` gera v4 — aleatório puro — que fragmenta o
 * índice B-tree justamente nas tabelas que mais crescem (orders, audit_logs,
 * inventory_movements) e destrói a ordenação natural por criação.
 *
 * O mesmo algoritmo existe no banco como app.uuid_generate_v7(); gerar na
 * aplicação permite preencher relações antes de escrever.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();

  // 48 bits de timestamp, big-endian, nos bytes 0..5
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // versão 7 no nibble alto do byte 6
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variante RFC 4122 (10xx) nos dois bits altos do byte 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
