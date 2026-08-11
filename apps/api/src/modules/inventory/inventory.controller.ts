import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { unauthorized } from '../../common/errors.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { ZodValidationPipe } from '../../common/http.js';
import { InventoryService } from './inventory.service.js';

const AdjustSchema = z
  .object({
    // [ +1 ] [ +5 ] [ +10 ] do painel, e ajustes negativos para correção.
    delta: z.number().int().min(-10_000).max(10_000).refine((v) => v !== 0, 'Informe um valor diferente de zero'),
    reason: z.string().max(300).optional(),
  })
  .strict();

const SoldOutSchema = z.object({ reason: z.string().max(300).optional() }).strict();

const ModeSchema = z
  .object({
    mode: z.enum(['INFINITE', 'LIMITED']),
    initialQuantity: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

@Controller('v1/branches/:branchId/inventory')
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}

  /** Painel: Produto | Disponível | Status. */
  @Get()
  @RequirePermission('inventory:read')
  async list(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.inventory.listForBranch(principal, branchId);
  }

  /** [ ESGOTAR ] */
  @Post(':productId/sold-out')
  @RequirePermission('inventory:mark_sold_out')
  async markSoldOut(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(new ZodValidationPipe(SoldOutSchema)) body: { reason?: string },
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.inventory.markSoldOut(principal, branchId, productId, body.reason);
  }

  /** [ REATIVAR ] */
  @Post(':productId/reactivate')
  @RequirePermission('inventory:mark_sold_out')
  async reactivate(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.inventory.reactivate(principal, branchId, productId);
  }

  /** [ +1 ] [ +5 ] [ +10 ] */
  @Post(':productId/adjust')
  @RequirePermission('inventory:adjust')
  async adjust(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(new ZodValidationPipe(AdjustSchema)) body: z.infer<typeof AdjustSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.inventory.adjustQuantity(principal, branchId, productId, body.delta, body.reason);
  }

  @Post(':productId/mode')
  @RequirePermission('inventory:adjust')
  async setMode(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(new ZodValidationPipe(ModeSchema)) body: z.infer<typeof ModeSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.inventory.setMode(principal, branchId, productId, body.mode, body.initialQuantity);
  }
}
