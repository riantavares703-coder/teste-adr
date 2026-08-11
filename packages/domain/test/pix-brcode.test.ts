import { describe, expect, it } from 'vitest';
import {
  buildPixBrCode,
  centsToEmvAmount,
  crc16ccitt,
  maskPixKey,
  parseEmv,
  PixBrCodeError,
  sanitizeEmvText,
  validateBrCodeChecksum,
} from '../src/pix-brcode.js';

describe('crc16ccitt', () => {
  it('bate com o valor de verificação padrão do CRC-16/CCITT-FALSE', () => {
    // Vetor de teste canônico do algoritmo: CRC("123456789") = 0x29B1
    expect(crc16ccitt('123456789')).toBe(0x29b1);
  });

  it('é determinístico e sensível a qualquer alteração', () => {
    expect(crc16ccitt('abc')).toBe(crc16ccitt('abc'));
    expect(crc16ccitt('abc')).not.toBe(crc16ccitt('abd'));
  });
});

describe('centsToEmvAmount', () => {
  it('converte centavos para decimal com ponto', () => {
    expect(centsToEmvAmount(5890)).toBe('58.90');
    expect(centsToEmvAmount(2990)).toBe('29.90');
    expect(centsToEmvAmount(100)).toBe('1.00');
    expect(centsToEmvAmount(5)).toBe('0.05');
  });

  it('recusa valor zero, negativo ou fracionário', () => {
    expect(() => centsToEmvAmount(0)).toThrow(PixBrCodeError);
    expect(() => centsToEmvAmount(-1)).toThrow(PixBrCodeError);
    expect(() => centsToEmvAmount(10.5)).toThrow(PixBrCodeError);
  });
});

describe('sanitizeEmvText', () => {
  it('remove acentos e caixa alta o texto', () => {
    expect(sanitizeEmvText('Padaria São João', 25)).toBe('PADARIA SAO JOAO');
  });

  it('trunca no limite do padrão', () => {
    expect(sanitizeEmvText('A'.repeat(40), 25)).toHaveLength(25);
  });

  it('descarta caracteres que quebrariam o parsing do TLV', () => {
    // Nome do lojista é conteúdo não confiável: não pode injetar estrutura.
    expect(sanitizeEmvText('Loja 62 05 ***', 25)).toBe('LOJA 62 05');
  });
});

describe('buildPixBrCode', () => {
  const input = {
    key: 'chave@lojateste.com.br',
    merchantName: 'Lanchonete do Zé',
    merchantCity: 'São Paulo',
    amountCents: 5890,
    txid: '1042',
  };

  it('gera um payload com checksum válido', () => {
    const code = buildPixBrCode(input);
    expect(validateBrCodeChecksum(code)).toBe(true);
  });

  it('embute valor, chave, nome e cidade nos campos corretos', () => {
    const parsed = parseEmv(buildPixBrCode(input));
    expect(parsed['00']).toBe('01'); // Payload Format Indicator
    expect(parsed['53']).toBe('986'); // BRL
    expect(parsed['54']).toBe('58.90'); // valor já preenchido
    expect(parsed['58']).toBe('BR');
    expect(parsed['59']).toBe('LANCHONETE DO ZE');
    expect(parsed['60']).toBe('SAO PAULO');

    const merchantAccount = parseEmv(parsed['26']);
    expect(merchantAccount['00']).toBe('br.gov.bcb.pix');
    expect(merchantAccount['01']).toBe('chave@lojateste.com.br');

    const additional = parseEmv(parsed['62']);
    expect(additional['05']).toBe('1042');
  });

  it('o valor embutido corresponde exatamente ao total do pedido', () => {
    // É esta propriedade que elimina o erro de digitação de valor.
    for (const cents of [1, 99, 100, 2990, 5890, 123456]) {
      const parsed = parseEmv(buildPixBrCode({ ...input, amountCents: cents }));
      expect(parsed['54']).toBe(centsToEmvAmount(cents));
    }
  });

  it('qualquer alteração no payload invalida o checksum', () => {
    const code = buildPixBrCode(input);
    // Simula adulteração do valor durante o transporte.
    const tampered = code.replace('58.90', '18.90');
    expect(tampered).not.toBe(code);
    expect(validateBrCodeChecksum(tampered)).toBe(false);
  });

  it('recusa chave vazia', () => {
    expect(() => buildPixBrCode({ ...input, key: '   ' })).toThrow(/não configurada/);
  });

  it('recusa chave acima do limite do padrão', () => {
    expect(() => buildPixBrCode({ ...input, key: 'x'.repeat(78) })).toThrow(PixBrCodeError);
  });

  it('usa fallback quando nome e cidade ficam vazios após sanitização', () => {
    const parsed = parseEmv(
      buildPixBrCode({ ...input, merchantName: '中文', merchantCity: '中文' }),
    );
    expect(parsed['59']).toBe('RECEBEDOR');
    expect(parsed['60']).toBe('BRASIL');
  });

  it('aceita os cinco tipos de chave Pix', () => {
    const keys = [
      '12345678909',
      '12345678000199',
      'contato@loja.com.br',
      '+5511999998888',
      '123e4567-e12b-12d1-a456-426655440000',
    ];
    for (const key of keys) {
      const code = buildPixBrCode({ ...input, key });
      expect(validateBrCodeChecksum(code), key).toBe(true);
      expect(parseEmv(parseEmv(code)['26'])['01']).toBe(key);
    }
  });
});

describe('maskPixKey', () => {
  it('mostra apenas os quatro últimos caracteres', () => {
    expect(maskPixKey('contato@loja.com.br')).toBe('•••m.br');
    expect(maskPixKey('12345678909')).toBe('•••8909');
  });
});
