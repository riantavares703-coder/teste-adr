import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { TenantContext } from '../db/client.js';

/**
 * Identidade resolvida da requisição.
 * `permissions` e `branchScope` são resolvidos no servidor a cada requisição
 * (com cache curto), NUNCA lidos do token — papel revogado deixa de valer em
 * segundos, não em 15 minutos (ADR-0005).
 */
export interface Principal {
  readonly userId: string;
  readonly userType: 'STAFF' | 'CUSTOMER';
  readonly organizationId: string | null;
  readonly fullName: string;
  readonly permissions: ReadonlySet<string>;
  /** Unidades acessíveis. Vazio + isOrgWide = toda a organização. */
  readonly branchScope: readonly string[];
  readonly isOrgWide: boolean;
  readonly isPlatformAdmin: boolean;
  readonly roles: readonly string[];
  readonly sessionId: string;
}

export function toTenantContext(principal: Principal | null): TenantContext {
  if (!principal) {
    return {
      userId: null,
      userType: 'NONE',
      organizationId: null,
      branchScope: [],
      isPlatformAdmin: false,
    };
  }
  return {
    userId: principal.userId,
    userType: principal.userType,
    organizationId: principal.organizationId,
    // Escopo de organização inteira => lista vazia (ver app.branch_in_scope).
    branchScope: principal.isOrgWide ? [] : principal.branchScope,
    isPlatformAdmin: principal.isPlatformAdmin,
  };
}

export function canReachBranch(principal: Principal, branchId: string): boolean {
  if (principal.isPlatformAdmin) return true;
  if (principal.isOrgWide) return true;
  return principal.branchScope.includes(branchId);
}

// --- decoradores de autorização ---------------------------------------------

export const PERMISSION_KEY = 'required_permission';
export const PUBLIC_KEY = 'is_public';

/**
 * Declara a permissão exigida pela rota.
 *
 * Negar por padrão: o PermissionGuard rejeita qualquer rota que não tenha
 * `@RequirePermission` nem `@Public`, e o teste test/route-coverage.test.ts
 * falha o build se alguma rota ficar sem declaração. Esquecer de proteger um
 * endpoint deixa de ser possível por distração.
 */
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

/** Rota pública (vitrine, cardápio, login). Ainda passa por rate limit. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | null =>
    ctx.switchToHttp().getRequest().principal ?? null,
);
