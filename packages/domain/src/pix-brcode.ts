/**
 * Gerador de BR Code Pix (EMV® QR Code — padrão Banco Central).
 *
 * ADR-0008: o briefing pede exibir a chave Pix com botão de copiar. Gerar o
 * BR Code é apenas FORMATAÇÃO PADRONIZADA dos dados que já temos (chave, nome,
 * cidade, valor) em campos TLV com CRC16 — não é integração bancária, não tem
 * custo e não envolve PSP.
 *
 * ATENÇÃO — o que isto NÃO faz: um BR Code estático não gera notificação de
 * recebimento. Copiar ou pagar NÃO confirma o pagamento. A confirmação continua
 * sendo um ato do operador (payment:confirm), exatamente como o briefing exige.
 */

export interface PixBrCodeInput {
  /** Chave Pix do recebedor (CPF/CNPJ/e-mail/telefone/aleatória). */
  readonly key: string;
  /** Nome do recebedor — o padrão EMV limita a 25 caracteres. */
  readonly merchantName: string;
  /** Cidade do recebedor — o padrão EMV limita a 15 caracteres. */
  readonly merchantCity: string;
  readonly amountCents: number;
  /** Identificador da transação (usamos o número do pedido). Máx. 25, alfanumérico. */
  readonly txid: string;
}

export class PixBrCodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PixBrCodeError';
  }
}

export type PixKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'RANDOM';

function cpfIsValid(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(d[len])) return false;
  }
  return true;
}

// CNPJ alfanumérico (vigente desde jul/2026): valor de cada caractere = código ASCII - 48.
// Para CNPJ só numérico o resultado é idêntico ao algoritmo clássico.
function cnpjIsValid(c: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const check = (len: number): number => {
    let sum = 0;
    let weight = len - 7;
    for (let i = 0; i < len; i++) {
      sum += (c.charCodeAt(i) - 48) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return check(12) === Number(c[12]) && check(13) === Number(c[13]);
}

/**
 * Converte o que o lojista digitou na forma canônica exigida pelo Banco Central
 * dentro do BR Code. Sem isto, "(11) 99999-1234" ou "123.456.789-09" viram um
 * código que o app do banco recusa ou que aponta para uma chave inexistente.
 */
export function normalizePixKey(type: PixKeyType, raw: string): string {
  const input = raw.trim();
  switch (type) {
    case 'CPF': {
      const digits = input.replace(/[.\-\s]/g, '');
      if (!cpfIsValid(digits)) throw new PixBrCodeError('INVALID_KEY', 'CPF inválido');
      return digits;
    }
    case 'CNPJ': {
      const cnpj = input.replace(/[.\-/\s]/g, '').toUpperCase();
      if (!cnpjIsValid(cnpj)) throw new PixBrCodeError('INVALID_KEY', 'CNPJ inválido');
      return cnpj;
    }
    case 'PHONE': {
      let digits = input.replace(/\D/g, '');
      if (digits.length >= 12 && digits.startsWith('55')) digits = digits.slice(2);
      if (!/^[1-9]\d\d{8,9}$/.test(digits)) {
        throw new PixBrCodeError('INVALID_KEY', 'Telefone inválido: informe DDD + número');
      }
      return `+55${digits}`;
    }
    case 'EMAIL': {
      const email = input.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 77) {
        throw new PixBrCodeError('INVALID_KEY', 'E-mail inválido');
      }
      return email;
    }
    case 'RANDOM': {
      const uuid = input.toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
        throw new PixBrCodeError('INVALID_KEY', 'Chave aleatória inválida (esperado um UUID)');
      }
      return uuid;
    }
  }
}

/** Monta um campo TLV: ID (2) + tamanho (2, zero-padded) + valor. */
export function tlv(id: string, value: string): string {
  if (id.length !== 2) {
    throw new PixBrCodeError('INVALID_TLV_ID', `ID do campo EMV deve ter 2 dígitos: "${id}"`);
  }
  const length = String(value.length).padStart(2, '0');
  if (value.length > 99) {
    throw new PixBrCodeError('TLV_TOO_LONG', `Campo ${id} excede 99 caracteres`);
  }
  return `${id}${length}${value}`;
}

/**
 * CRC-16/CCITT-FALSE — polinômio 0x1021, valor inicial 0xFFFF, sem reflexão.
 * Valor de verificação padrão: CRC("123456789") === 0x29B1.
 */
export function crc16ccitt(payload: string): number {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Remove acentos e caracteres fora do conjunto aceito pelo padrão.
 * Nome de recebedor vem do cadastro do lojista — é conteúdo não confiável e
 * não pode injetar caracteres que quebrem o parsing do TLV.
 */
export function sanitizeEmvText(value: string, maxLength: number): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 .,'-]/g, '')
    .trim()
    .slice(0, maxLength)
    .toUpperCase();
}

function sanitizeTxid(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9]/g, '').slice(0, 25);
  return cleaned.length > 0 ? cleaned : '***';
}

/** Converte centavos para o formato decimal com ponto exigido pelo EMV. */
export function centsToEmvAmount(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new PixBrCodeError('INVALID_AMOUNT', 'Valor deve ser inteiro em centavos');
  }
  if (cents <= 0) {
    throw new PixBrCodeError('INVALID_AMOUNT', 'Valor deve ser positivo');
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function buildPixBrCode(input: PixBrCodeInput): string {
  const key = input.key.trim();
  if (!key) {
    throw new PixBrCodeError('MISSING_KEY', 'Chave Pix não configurada para esta unidade');
  }
  if (key.length > 77) {
    throw new PixBrCodeError('KEY_TOO_LONG', 'Chave Pix excede o limite do padrão EMV');
  }

  const merchantName = sanitizeEmvText(input.merchantName, 25) || 'RECEBEDOR';
  const merchantCity = sanitizeEmvText(input.merchantCity, 15) || 'BRASIL';
  const amount = centsToEmvAmount(input.amountCents);
  const txid = sanitizeTxid(input.txid);

  const merchantAccountInfo = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);
  const additionalData = tlv('05', txid);

  const payload =
    tlv('00', '01') + // Payload Format Indicator
    tlv('01', '12') + // Point of Initiation: uso único (cada pedido tem o seu)
    tlv('26', merchantAccountInfo) +
    tlv('52', '0000') + // Merchant Category Code — não especificado
    tlv('53', '986') + // Moeda: BRL (ISO 4217)
    tlv('54', amount) +
    tlv('58', 'BR') +
    tlv('59', merchantName) +
    tlv('60', merchantCity) +
    tlv('62', additionalData);

  // O CRC é calculado sobre o payload já contendo "6304".
  const withCrcPlaceholder = `${payload}6304`;
  const crc = crc16ccitt(withCrcPlaceholder).toString(16).toUpperCase().padStart(4, '0');

  return `${withCrcPlaceholder}${crc}`;
}

/** Parser usado nos testes e na validação do código gerado. */
export function parseEmv(payload: string): Record<string, string> {
  const result: Record<string, string> = {};
  let cursor = 0;
  while (cursor < payload.length) {
    const id = payload.slice(cursor, cursor + 2);
    const length = Number.parseInt(payload.slice(cursor + 2, cursor + 4), 10);
    if (Number.isNaN(length)) {
      throw new PixBrCodeError('MALFORMED', `Tamanho inválido no campo ${id}`);
    }
    result[id] = payload.slice(cursor + 4, cursor + 4 + length);
    cursor += 4 + length;
  }
  return result;
}

export function validateBrCodeChecksum(payload: string): boolean {
  if (payload.length < 8) return false;
  const body = payload.slice(0, -4);
  const provided = payload.slice(-4).toUpperCase();
  const expected = crc16ccitt(body).toString(16).toUpperCase().padStart(4, '0');
  return provided === expected;
}

/** Mascaramento para exibição: nunca mostramos a chave completa fora do pagamento. */
export function maskPixKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '•'.repeat(trimmed.length);
  return `•••${trimmed.slice(-4)}`;
}
