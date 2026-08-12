/**
 * Telefone brasileiro: máscara para digitar, E.164 para enviar.
 *
 * A API exige E.164 (`+5511987654321`), mas ninguém digita assim. A conversão
 * fica aqui, num lugar só, e a validação de verdade continua no servidor.
 */

/** `(11) 98765-4321` enquanto o cliente digita. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

/** Devolve `+55DDNNNNNNNNN`, ou null se o número não estiver completo. */
export function toE164(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  // 10 dígitos = fixo com DDD; 11 = celular com o 9 na frente.
  if (digits.length !== 10 && digits.length !== 11) return null;
  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  return `+55${digits}`;
}
