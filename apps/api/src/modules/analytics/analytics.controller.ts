import { Controller, Get, Inject, Query } from '@nestjs/common';
import { unauthorized } from '../../common/errors.js';
import { CurrentUser, RequirePermission, type Principal } from '../../common/principal.js';
import { AnalyticsService } from './analytics.service.js';

@Controller('v1')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  /**
   * Indicadores da franquia.
   *
   * Repare que NÃO existe `organizationId` no parâmetro. A organização vem do
   * principal, resolvida no servidor a cada requisição. Se viesse na URL, esta
   * seria a rota mais fácil de atacar do sistema inteiro: trocar um UUID e ler
   * o faturamento do concorrente.
   *
   * `branchId` é opcional e serve para FILTRAR dentro do que já é permitido —
   * nunca para ampliar.
   */
  @Get('analytics/summary')
  @RequirePermission('report:read')
  async summary(
    @Query('days') days: string | undefined,
    @Query('branchId') branchId: string | undefined,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.analytics.summary(principal, {
      days: days ? Number(days) : 30,
      branchId: branchId || undefined,
    });
  }

  /**
   * Faturamento ao longo do tempo, comparado ao período anterior.
   *
   * Mesmo escopo do resumo: sem `organizationId` no parâmetro, e `branchId`
   * apenas filtrando dentro do que o papel já permite.
   */
  @Get('analytics/revenue')
  @RequirePermission('report:read')
  async revenue(
    @Query('days') days: string | undefined,
    @Query('branchId') branchId: string | undefined,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.analytics.revenue(principal, {
      days: days ? Number(days) : 30,
      branchId: branchId || undefined,
    });
  }
}
