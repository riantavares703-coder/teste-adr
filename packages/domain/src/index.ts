/**
 * @plataforma/domain — regras de negócio puras, sem I/O.
 *
 * Este pacote é compartilhado entre o backend e os apps React Native:
 *  - o app usa para exibir um total otimista e montar os botões de status;
 *  - o servidor usa para DECIDIR o que é cobrado e o que pode transitar.
 *
 * O app mostra; o servidor cobra. Divergência entre os dois nunca favorece
 * o cliente, porque o valor persistido é o calculado no servidor.
 */

export * from './order-status.js';
export * from './payment-status.js';
export * from './pricing.js';
export * from './availability.js';
export * from './pix-brcode.js';
export * from './order-number.js';
export * from './branding.js';
