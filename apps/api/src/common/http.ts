import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type PipeTransform,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

/**
 * Validação com Zod em MODO ESTRITO.
 *
 * `.strict()` faz campo não declarado virar erro 400 em vez de ser ignorado —
 * é a defesa estrutural contra mass assignment. Enviar `"totalCents": 1`,
 * `"status": "CONFIRMED"` ou `"organizationId": "<outra>"` resulta em 400,
 * nunca em campo aceito por engano.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new HttpException(
        {
          code: 'ENTRADA_INVALIDA',
          title: 'Dados inválidos',
          status: HttpStatus.BAD_REQUEST,
          details: result.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return result.data;
  }
}

function isHttpishError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const value = candidate.status ?? candidate.statusCode;
  return typeof value === 'number' && value >= 400 && value < 600;
}

/** Erros no formato RFC 9457, sem stack trace nem detalhe de banco. */
@Catch()
@Injectable()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ url?: string; requestId?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = {
      code: 'ERRO_INTERNO',
      title: 'Erro interno',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      body =
        typeof payload === 'object' && payload !== null
          ? { ...(payload as Record<string, unknown>) }
          : { code: 'ERRO', title: String(payload) };
    } else if (isHttpishError(exception)) {
      // Erros do express (ex.: PayloadTooLargeError do body-parser) trazem o
      // status na própria exceção. Sem isto, um upload grande viraria 500 —
      // e um 500 esconde do cliente que o problema é dele, não nosso.
      const e = exception as { status?: number; statusCode?: number };
      status = e.status ?? e.statusCode ?? HttpStatus.BAD_REQUEST;
      body = {
        code: status === HttpStatus.PAYLOAD_TOO_LARGE ? 'ARQUIVO_GRANDE' : 'REQUISICAO_INVALIDA',
        title:
          status === HttpStatus.PAYLOAD_TOO_LARGE
            ? 'Arquivo maior que o limite permitido'
            : 'Requisição inválida',
      };
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      body = { code: 'ENTRADA_INVALIDA', title: 'Dados inválidos' };
    } else {
      // Só o log recebe o detalhe. A resposta nunca revela SQL, nome de tabela
      // nem stack — isso é informação para o atacante, não para o usuário.
      this.logger.error(
        `${request.url}: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    delete body.message;
    delete body.statusCode;

    response
      .status(status)
      .type('application/problem+json')
      .json({ ...body, status, instance: request.url, traceId: request.requestId });
  }
}
