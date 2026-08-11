import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Erros da aplicação no formato RFC 9457 (application/problem+json).
 *
 * Regra de ouro do isolamento multi-tenant: recurso fora do escopo devolve
 * NOT_FOUND, nunca FORBIDDEN. Um 403 confirma que o recurso existe e permite
 * enumerar os pedidos de uma franquia concorrente pela diferença de resposta.
 * FORBIDDEN fica reservado a "existe, você alcança, mas seu papel não permite".
 */
export class AppError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, title: message, status, ...(details ? { details } : {}) }, status);
  }
}

export const notFound = (code = 'NAO_ENCONTRADO', message = 'Recurso não encontrado') =>
  new AppError(code, message, HttpStatus.NOT_FOUND);

export const forbidden = (code = 'PROIBIDO', message = 'Ação não permitida para o seu papel') =>
  new AppError(code, message, HttpStatus.FORBIDDEN);

export const unauthorized = (code = 'NAO_AUTENTICADO', message = 'Autenticação necessária') =>
  new AppError(code, message, HttpStatus.UNAUTHORIZED);

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, HttpStatus.CONFLICT, details);

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, HttpStatus.BAD_REQUEST, details);

export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);

export const tooManyRequests = (code = 'MUITAS_TENTATIVAS', message = 'Tente novamente mais tarde') =>
  new AppError(code, message, HttpStatus.TOO_MANY_REQUESTS);
