import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ORDER_STATUS, type OrderStatus } from '@plataforma/domain';
import { badRequest, unauthorized } from '../../common/errors.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { ZodValidationPipe } from '../../common/http.js';
import { OrderingService } from './ordering.service.js';

/**
 * Schemas em MODO ESTRITO (.strict()).
 *
 * Repare no que NÃO existe aqui: nenhum campo de preço, subtotal, total,
 * desconto ou status. O cliente envia INTENÇÃO (o que quer, quanto quer);
 * o servidor decide o RESULTADO. Enviar `price: 1.00` para um produto de
 * R$ 29,90 resulta em 400 — o campo sequer é reconhecido.
 */
const CreateOrderSchema = z
  .object({
    branchId: z.string().uuid(),
    fulfillment: z.enum(['PICKUP', 'DELIVERY']),
    paymentMethod: z.enum(['PIX', 'CREDIT_ON_SITE', 'DEBIT_ON_SITE', 'CASH_ON_SITE']),
    items: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(999),
            optionIds: z.array(z.string().uuid()).max(20).optional(),
            notes: z.string().max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    deliveryAddressId: z.string().uuid().optional(),
    customerNotes: z.string().max(500).optional(),
    changeForCents: z.number().int().min(0).optional(),
    /** Comparação apenas — nunca cobra. Divergência devolve 409 com o novo total. */
    expectedTotalCents: z.number().int().min(0).optional(),
  })
  .strict();

const TransitionSchema = z
  .object({
    to: z.enum(ORDER_STATUS as unknown as [string, ...string[]]),
    reason: z.string().max(500).optional(),
  })
  .strict();

@Controller('v1')
export class OrderingController {
  constructor(@Inject(OrderingService) private readonly ordering: OrderingService) {}

  // --- cliente ---------------------------------------------------------------

  @Post('orders')
  @RequirePermission('order:create')
  async create(
    // O pipe vai no @Body, NÃO em @UsePipes no método: @UsePipes aplica a
    // TODOS os parâmetros, e acabaria validando o principal em vez do corpo.
    @Body(new ZodValidationPipe(CreateOrderSchema)) body: z.infer<typeof CreateOrderSchema>,
    @CurrentUser() principal: Principal | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: { ip?: string; requestId?: string },
  ) {
    if (!principal) throw unauthorized();
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw badRequest(
        'IDEMPOTENCY_KEY_OBRIGATORIA',
        'Cabeçalho Idempotency-Key é obrigatório na criação de pedido',
      );
    }

    const result = await this.ordering.createOrder(principal, body as never, {
      idempotencyKey,
      ip: req.ip,
      requestId: req.requestId,
    });

    const detail = await this.ordering.getOrderDetail(principal, result.orderId);
    return { ...detail, replayed: result.replayed };
  }

  @Get('orders')
  @RequirePermission('order:read_own')
  async listMine(@CurrentUser() principal: Principal | null) {
    if (!principal) throw unauthorized();
    return this.ordering.listCustomerOrders(principal);
  }

  @Get('orders/:id')
  @RequirePermission('order:read_own')
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    // RLS + posse decidem: pedido de outro cliente devolve 404, nunca 403.
    return this.ordering.getOrderDetail(principal, id);
  }

  @Post('orders/:id/cancel')
  @RequirePermission('order:read_own')
  async cancelOwn(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: Principal | null,
    @Req() req: { ip?: string },
  ) {
    if (!principal) throw unauthorized();
    const { order } = await this.ordering.getOrderDetail(principal, id);
    return this.ordering.transition(principal, order.branchId, id, 'CANCELLED', { ip: req.ip });
  }

  // --- operação --------------------------------------------------------------

  /** Fila do painel do operador (item 9). */
  @Get('branches/:branchId/orders')
  @RequirePermission('order:read')
  async listBranch(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
    @Query('status') status?: string,
  ) {
    if (!principal) throw unauthorized();
    const statuses = status
      ? (status.split(',').filter((v) => (ORDER_STATUS as readonly string[]).includes(v)) as OrderStatus[])
      : undefined;
    return this.ordering.listBranchOrders(principal, branchId, { statuses });
  }

  @Get('branches/:branchId/orders/:id')
  @RequirePermission('order:read')
  async branchOrderDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.ordering.getOrderDetail(principal, id);
  }

  /** Mudança de status (item 10). */
  @Post('branches/:branchId/orders/:id/transition')
  @RequirePermission('order:read')
  async transition(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(TransitionSchema)) body: { to: string; reason?: string },
    @CurrentUser() principal: Principal | null,
    @Req() req: { ip?: string },
  ) {
    if (!principal) throw unauthorized();
    // A permissão específica da transição (order:transition / order:cancel)
    // é conferida dentro do serviço, a partir da regra da máquina de estados.
    return this.ordering.transition(principal, branchId, id, body.to as OrderStatus, {
      reason: body.reason,
      ip: req.ip,
    });
  }
}
