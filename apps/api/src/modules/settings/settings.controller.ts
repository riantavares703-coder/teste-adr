import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { z } from 'zod';
import { PAYMENT_METHOD } from '@plataforma/domain';
import { unauthorized } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/http.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { SettingsService } from './settings.service.js';

const SettingsSchema = z
  .object({
    preparationTimeMinutes: z.number().int().min(0).max(480).optional(),
    minOrderCents: z.number().int().min(0).optional(),
    autoAcceptOrders: z.boolean().optional(),
    paymentHoldMinutes: z.number().int().min(1).max(120).optional(),
    cancellationWindowMinutes: z.number().int().min(0).optional(),
    enabledPaymentMethods: z
      .array(z.enum(PAYMENT_METHOD as unknown as [string, ...string[]]))
      .min(1, 'Aceite ao menos uma forma de pagamento')
      .optional(),
  })
  .strict();

/** `HH:MM`, o que o campo de hora do navegador produz. */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use um horário no formato HH:MM');

const HoursSchema = z
  .object({
    hours: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            opensAt: time,
            closesAt: time,
          })
          .strict(),
      )
      // 21 faixas = três por dia, folgado para café/almoço/jantar. O teto
      // existe só para impedir um corpo absurdo.
      .max(21),
  })
  .strict();

@Controller('v1')
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get('branches/:branchId/settings')
  @RequirePermission('settings:read')
  async get(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.settings.get(principal, branchId);
  }

  @Put('branches/:branchId/settings')
  @RequirePermission('settings:update')
  async update(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(new ZodValidationPipe(SettingsSchema)) body: z.infer<typeof SettingsSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.settings.update(principal, branchId, body as never);
  }

  /** Substitui o horário inteiro — ver a justificativa em `replaceHours`. */
  @Put('branches/:branchId/hours')
  @RequirePermission('settings:update')
  async replaceHours(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(new ZodValidationPipe(HoursSchema)) body: z.infer<typeof HoursSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.settings.replaceHours(principal, branchId, body.hours as never);
  }
}
