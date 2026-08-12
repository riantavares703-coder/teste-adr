import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { unauthorized } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/http.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { ModifiersService } from './modifiers.service.js';

const GroupSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    minSelect: z.number().int().min(0).max(20).optional(),
    maxSelect: z.number().int().min(1).max(20).optional(),
    isRequired: z.boolean().optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const OptionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    // Negativo é legítimo: "sem queijo −R$ 2,00".
    priceDeltaCents: z.number().int().min(-100_000).max(100_000).optional(),
    isAvailable: z.boolean().optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const GroupIdsSchema = z.object({ groupIds: z.array(z.string().uuid()).max(20) }).strict();

/**
 * `product:update` em tudo: montar as opções que o cliente escolhe é editar o
 * cardápio, e quem pode mexer no preço do produto é quem pode mexer no preço
 * do adicional.
 */
@Controller('v1/branches/:branchId')
export class ModifiersController {
  constructor(@Inject(ModifiersService) private readonly modifiers: ModifiersService) {}

  @Get('modifier-groups')
  @RequirePermission('product:read')
  async list(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.modifiers.list(principal, branchId);
  }

  @Post('modifier-groups')
  @RequirePermission('product:update')
  async createGroup(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(new ZodValidationPipe(GroupSchema)) body: z.infer<typeof GroupSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.modifiers.createGroup(principal, branchId, body);
  }

  @Patch('modifier-groups/:groupId')
  @RequirePermission('product:update')
  async updateGroup(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body(new ZodValidationPipe(GroupSchema.partial())) body: Partial<z.infer<typeof GroupSchema>>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.modifiers.updateGroup(principal, branchId, groupId, body);
  }

  @Delete('modifier-groups/:groupId')
  @RequirePermission('product:update')
  async deleteGroup(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    await this.modifiers.deleteGroup(principal, branchId, groupId);
    return { deleted: true };
  }

  @Post('modifier-groups/:groupId/options')
  @RequirePermission('product:update')
  async createOption(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body(new ZodValidationPipe(OptionSchema)) body: z.infer<typeof OptionSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.modifiers.createOption(principal, branchId, groupId, body);
  }

  @Patch('modifier-options/:optionId')
  @RequirePermission('product:update')
  async updateOption(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('optionId', ParseUUIDPipe) optionId: string,
    @Body(new ZodValidationPipe(OptionSchema.partial())) body: Partial<z.infer<typeof OptionSchema>>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.modifiers.updateOption(principal, branchId, optionId, body);
  }

  @Delete('modifier-options/:optionId')
  @RequirePermission('product:update')
  async deleteOption(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('optionId', ParseUUIDPipe) optionId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    await this.modifiers.deleteOption(principal, branchId, optionId);
    return { deleted: true };
  }

  @Put('products/:productId/modifier-groups')
  @RequirePermission('product:update')
  async setProductGroups(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(new ZodValidationPipe(GroupIdsSchema)) body: z.infer<typeof GroupIdsSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    await this.modifiers.setProductGroups(principal, branchId, productId, body.groupIds);
    return { ok: true };
  }
}
