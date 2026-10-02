import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { unauthorized } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/http.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { originFromHost } from './public-url.js';
import { StorefrontService, type ShareContext } from './storefront.service.js';

const PublicBaseUrlSchema = z
  .object({ publicBaseUrl: z.string().trim().max(300).nullable() })
  .strict();

interface RequestLike {
  protocol: string;
  get(name: string): string | undefined;
}

/**
 * Por qual endereço o painel foi aberto. Com `trust proxy` ligado, o Express já
 * entrega o protocolo certo atrás de um proxy/CDN; o host público vem em
 * `X-Forwarded-Host`. Só alimenta o link mostrado ao PRÓPRIO operador autenticado.
 */
function contextOf(req: RequestLike): ShareContext {
  return { requestOrigin: originFromHost(req.protocol, req.get('x-forwarded-host') ?? req.get('host')) };
}

@Controller('v1')
export class StorefrontController {
  constructor(@Inject(StorefrontService) private readonly storefront: StorefrontService) {}

  /**
   * Endereço do cardápio desta unidade, para o QR code do balcão.
   *
   * `branch:read` porque é exatamente isso que a rota entrega — um dado público
   * da unidade — e é a permissão que o OPERADOR já tem: quem atende o balcão
   * precisa conseguir mostrar o cardápio sem depender do gerente.
   */
  @Get('branches/:branchId/share-link')
  @RequirePermission('branch:read')
  async shareLink(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
    @Req() req: RequestLike,
  ) {
    if (!principal) throw unauthorized();
    return this.storefront.shareLink(principal, branchId, contextOf(req));
  }

  /** Cadastra ou remove o endereço público. Mudar o endereço é decisão de quem gerencia a loja. */
  @Put('branches/:branchId/share-link')
  @RequirePermission('settings:update')
  async setPublicBaseUrl(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(new ZodValidationPipe(PublicBaseUrlSchema)) body: z.infer<typeof PublicBaseUrlSchema>,
    @CurrentUser() principal: Principal | null,
    @Req() req: RequestLike,
  ) {
    if (!principal) throw unauthorized();
    return this.storefront.setPublicBaseUrl(principal, branchId, body.publicBaseUrl, contextOf(req));
  }

  /** Testa se o endereço em uso abre este sistema a partir da internet. */
  @Post('branches/:branchId/share-link/check')
  @RequirePermission('settings:update')
  async check(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
    @Req() req: RequestLike,
  ) {
    if (!principal) throw unauthorized();
    return this.storefront.checkLink(principal, branchId, contextOf(req));
  }
}
