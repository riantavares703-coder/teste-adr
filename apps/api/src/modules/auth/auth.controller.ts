import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { unauthorized } from '../../common/errors.js';
import { CurrentUser, Public, RequirePermission, type Principal } from '../../common/principal.js';
import { ZodValidationPipe } from '../../common/http.js';
import { AuthService } from './auth.service.js';

const LoginSchema = z
  .object({
    organizationSlug: z.string().min(1).max(50),
    email: z.string().email().max(254),
    password: z.string().min(1).max(128),
    deviceId: z.string().max(200).optional(),
  })
  .strict();

const OtpRequestSchema = z
  .object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Telefone em formato E.164') })
  .strict();

const OtpVerifySchema = z
  .object({
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    code: z.string().length(6),
    fullName: z.string().max(120).optional(),
    deviceId: z.string().max(200).optional(),
  })
  .strict();

/**
 * Cliente de balcão: nome e telefone, sem código.
 *
 * O nome é obrigatório aqui (diferente do OTP, onde é opcional) porque é a
 * ÚNICA coisa que o operador tem para chamar quem pediu — sem ele o pedido
 * chega à fila sem dono.
 */
const GuestSchema = z
  .object({
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Telefone em formato E.164'),
    fullName: z.string().trim().min(2, 'Informe seu nome').max(120),
    deviceId: z.string().max(200).optional(),
  })
  .strict();

const RefreshSchema = z
  .object({ refreshToken: z.string().min(10).max(500), deviceId: z.string().max(200).optional() })
  .strict();

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Operador / administrador. */
  @Post('login')
  @Public()
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Req() req: { ip?: string; headers: Record<string, string | undefined> },
  ) {
    return this.auth.loginStaff({
      ...body,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /** Cliente: solicita o código. Resposta idêntica exista ou não a conta. */
  @Post('otp/request')
  @Public()
  async requestOtp(@Body(new ZodValidationPipe(OtpRequestSchema)) body: { phone: string }) {
    return this.auth.requestOtp(body.phone);
  }

  @Post('otp/verify')
  @Public()
  async verifyOtp(
    @Body(new ZodValidationPipe(OtpVerifySchema)) body: z.infer<typeof OtpVerifySchema>,
    @Req() req: { ip?: string },
  ) {
    return this.auth.verifyOtp({
      phoneE164: body.phone,
      code: body.code,
      fullName: body.fullName,
      deviceId: body.deviceId,
      ip: req.ip,
    });
  }

  /** Cliente que chegou pelo QR code e não tem conta. */
  @Post('guest')
  @Public()
  async guest(
    @Body(new ZodValidationPipe(GuestSchema)) body: z.infer<typeof GuestSchema>,
    @Req() req: { ip?: string; headers: Record<string, string | undefined> },
  ) {
    return this.auth.startGuestSession({
      phoneE164: body.phone,
      fullName: body.fullName,
      deviceId: body.deviceId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('refresh')
  @Public()
  async refresh(
    @Body(new ZodValidationPipe(RefreshSchema)) body: z.infer<typeof RefreshSchema>,
    @Req() req: { ip?: string },
  ) {
    return this.auth.refresh(body.refreshToken, { ip: req.ip, deviceId: body.deviceId });
  }

  @Post('logout')
  @RequirePermission('branch:read')
  async logout(@CurrentUser() principal: Principal | null) {
    if (!principal) throw unauthorized();
    await this.auth.logout(principal.sessionId);
    return { ok: true };
  }

  /** Perfil do usuário logado — define qual experiência o app monta. */
  @Get('me')
  @Public()
  async me(@CurrentUser() principal: Principal | null) {
    if (!principal) throw unauthorized();
    return {
      userId: principal.userId,
      userType: principal.userType,
      fullName: principal.fullName,
      organizationId: principal.organizationId,
      roles: principal.roles,
      permissions: [...principal.permissions].sort(),
      branchScope: principal.branchScope,
      isOrgWide: principal.isOrgWide,
      isPlatformAdmin: principal.isPlatformAdmin,
    };
  }
}
