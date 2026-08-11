import { Inject, Injectable, type CallHandler, type CanActivate, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { AuthService } from '../modules/auth/auth.service.js';
import { TokenService } from '../modules/auth/token.service.js';
import { forbidden, unauthorized } from './errors.js';
import { PERMISSION_KEY, PUBLIC_KEY, type Principal } from './principal.js';

/**
 * Guard único de autenticação + autorização.
 *
 * NEGA POR PADRÃO: uma rota sem `@RequirePermission` e sem `@Public` é
 * rejeitada com 403. Não existe "esqueci de proteger" — existe rota quebrada,
 * que o teste de cobertura (test/route-coverage.test.ts) pega no CI.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const handler = context.getHandler();
    const controller = context.getClass();

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller]);
    const permission = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      handler,
      controller,
    ]);

    // Mesmo em rota pública, um token válido é resolvido — a vitrine muda
    // quando o cliente está autenticado.
    const principal = await this.tryResolvePrincipal(request);
    request.principal = principal;

    if (isPublic) return true;

    if (permission === undefined) {
      // Rota sem declaração de permissão: negar. Fail-closed.
      throw forbidden(
        'ROTA_SEM_PERMISSAO_DECLARADA',
        'Rota não declara @RequirePermission nem @Public',
      );
    }

    if (!principal) throw unauthorized();

    if (!principal.permissions.has(permission)) {
      throw forbidden('PERMISSAO_NEGADA', `Permissão necessária: ${permission}`);
    }

    return true;
  }

  private async tryResolvePrincipal(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<Principal | null> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    if (!token) return null;
    const claims = await this.tokens.verifyAccessToken(token);
    return this.auth.resolvePrincipal(claims);
  }
}

/** Anexa um identificador de requisição para correlação em log e auditoria. */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const requestId = request.headers['x-request-id'] ?? crypto.randomUUID();
    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    return next.handle();
  }
}
