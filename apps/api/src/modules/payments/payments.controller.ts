import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { unauthorized } from '../../common/errors.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { ZodValidationPipe } from '../../common/http.js';
import { PaymentsService } from './payments.service.js';

/**
 * Repare que o schema de confirmação NÃO tem campo de valor.
 * O valor cobrado vem de `orders.total_cents` — nunca da requisição. Um
 * operador não consegue confirmar "R$ 1,00" para um pedido de R$ 58,90.
 */
const ConfirmSchema = z.object({ note: z.string().max(300).optional() }).strict();

const PixSettingsSchema = z
  .object({
    keyType: z.enum(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM']),
    key: z.string().min(1).max(77),
    merchantName: z.string().min(1).max(25),
    merchantCity: z.string().min(1).max(15),
  })
  .strict();

@Controller('v1')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  /** Tela de pagamento do cliente: valor, chave mascarada, BR Code. */
  @Get('orders/:orderId/payment')
  @RequirePermission('order:read_own')
  async forOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.payments.getPaymentForOrder(principal, orderId);
  }

  /** Confirmação manual do recebimento pelo operador. */
  @Post('branches/:branchId/payments/:paymentId/confirm')
  @RequirePermission('payment:confirm')
  async confirm(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body(new ZodValidationPipe(ConfirmSchema)) body: { note?: string },
    @CurrentUser() principal: Principal | null,
    @Req() req: { ip?: string },
  ) {
    if (!principal) throw unauthorized();
    return this.payments.confirmManually(principal, branchId, paymentId, {
      note: body.note,
      ip: req.ip,
    });
  }

  /** Configuração da chave Pix da unidade. */
  @Put('branches/:branchId/pix-settings')
  @RequirePermission('pix_settings:update')
  async setPix(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(new ZodValidationPipe(PixSettingsSchema)) body: z.infer<typeof PixSettingsSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.payments.upsertPixSettings(principal, branchId, body);
  }
}
