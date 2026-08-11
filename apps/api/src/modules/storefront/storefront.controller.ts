import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { unauthorized } from '../../common/errors.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { StorefrontService } from './storefront.service.js';

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
  ) {
    if (!principal) throw unauthorized();
    return this.storefront.shareLink(principal, branchId);
  }
}
