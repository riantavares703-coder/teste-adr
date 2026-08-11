import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { z } from 'zod';
import { FONT_TOKENS, GRADIENT_TOKENS } from '@plataforma/domain';
import { unauthorized } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/http.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { BrandingService } from './branding.service.js';

/**
 * Schema da aparência.
 *
 * `.strict()` recusa qualquer chave não declarada. Isso importa mais aqui do
 * que na maioria dos endpoints: é a rota que grava ESTILO, e é exatamente onde
 * alguém tentaria pendurar um `customCss`, `styleOverride` ou `fontUrl`. Com
 * strict, a requisição é rejeitada em vez de o campo ser silenciosamente
 * ignorado — e o lojista descobre na hora que aquilo não existe.
 *
 * O tipo dos campos já é a defesa: `hex` e `enum`, nunca `string` livre.
 */
const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB')
  .nullable()
  .optional();

const BrandingSchema = z
  .object({
    displayName: z.string().max(60).nullable().optional(),
    tagline: z.string().max(120).nullable().optional(),
    primaryColor: hex,
    secondaryColor: hex,
    accentColor: hex,
    textColor: hex,
    backgroundColor: hex,
    cardColor: hex,
    gradientFrom: hex,
    gradientTo: hex,
    fontToken: z.enum(FONT_TOKENS as unknown as [string, ...string[]]).nullable().optional(),
    gradientStyle: z.enum(GRADIENT_TOKENS as unknown as [string, ...string[]]).nullable().optional(),
  })
  .strict();

@Controller('v1')
export class BrandingController {
  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  @Get('branches/:branchId/branding')
  @RequirePermission('settings:read')
  async get(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.branding.get(principal, branchId);
  }

  @Put('branches/:branchId/branding')
  @RequirePermission('branding:update')
  async update(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(new ZodValidationPipe(BrandingSchema)) body: z.infer<typeof BrandingSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.branding.update(principal, branchId, body);
  }
}
