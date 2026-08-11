import { Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Database } from './db/client.js';
import { BranchAccessService } from './modules/tenancy/branch-access.service.js';
import { loadEnv } from './config/env.js';
import { AuthGuard, RequestIdInterceptor } from './common/guards.js';
import { ProblemDetailsFilter } from './common/http.js';

import { AuthController } from './modules/auth/auth.controller.js';
import { AuthService } from './modules/auth/auth.service.js';
import { PasswordService } from './modules/auth/password.service.js';
import { TokenService } from './modules/auth/token.service.js';
import { OtpDeliveryService } from './modules/auth/otp-delivery.service.js';
import { AuditService } from './modules/audit/audit.service.js';
import { CatalogController } from './modules/catalog/catalog.controller.js';
import { CatalogService } from './modules/catalog/catalog.service.js';
import { BrandingController } from './modules/branding/branding.controller.js';
import { BrandingService } from './modules/branding/branding.service.js';
import { AnalyticsController } from './modules/analytics/analytics.controller.js';
import { AnalyticsService } from './modules/analytics/analytics.service.js';
import { StorefrontController } from './modules/storefront/storefront.controller.js';
import { StorefrontService } from './modules/storefront/storefront.service.js';
import { InventoryController } from './modules/inventory/inventory.controller.js';
import { InventoryService } from './modules/inventory/inventory.service.js';
import { OrderingController } from './modules/ordering/ordering.controller.js';
import { OrderingService } from './modules/ordering/ordering.service.js';
import { PaymentsController } from './modules/payments/payments.controller.js';
import { PaymentsService } from './modules/payments/payments.service.js';
import { CryptoService } from './modules/payments/crypto.service.js';
import { MediaController } from './modules/media/media.controller.js';
import { MediaService } from './modules/media/media.service.js';
import { OutboxService } from './modules/notifications/outbox.service.js';
import {
  NotificationService,
  PUSH_PROVIDER,
  WHATSAPP_PROVIDER,
} from './modules/notifications/notification.service.js';
import {
  LoggingWhatsAppProvider,
  MetaCloudApiWhatsAppProvider,
} from './modules/notifications/whatsapp.provider.js';
import { ExpoPushProvider, LoggingPushProvider } from './modules/notifications/push.provider.js';
import { RealtimeGateway } from './modules/realtime/realtime.gateway.js';
import { SchedulerService } from './modules/scheduler/scheduler.service.js';

/**
 * Seleção do provedor de WhatsApp.
 *
 * Sem credencial configurada, entra o LoggingWhatsAppProvider — que registra e
 * devolve SKIPPED, NUNCA fingindo que enviou. O adapter real da Meta só é
 * instanciado quando há token de fato.
 */
const whatsappProvider: Provider = {
  provide: WHATSAPP_PROVIDER,
  useFactory: () => {
    const env = loadEnv();
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (env.WHATSAPP_PROVIDER === 'META_CLOUD_API' && token && phoneNumberId) {
      return new MetaCloudApiWhatsAppProvider({
        baseUrl: env.WHATSAPP_API_BASE_URL,
        accessToken: token,
        phoneNumberId,
      });
    }
    return new LoggingWhatsAppProvider();
  },
};

const pushProvider: Provider = {
  provide: PUSH_PROVIDER,
  useFactory: () => {
    const env = loadEnv();
    return env.PUSH_PROVIDER === 'EXPO'
      ? new ExpoPushProvider({ url: env.EXPO_PUSH_URL })
      : new LoggingPushProvider();
  },
};

@Module({
  controllers: [
    AuthController,
    CatalogController,
    InventoryController,
    OrderingController,
    PaymentsController,
    MediaController,
    BrandingController,
    AnalyticsController,
    StorefrontController,
  ],
  providers: [
    Database,
    BranchAccessService,
    AuditService,
    OutboxService,
    PasswordService,
    TokenService,
    OtpDeliveryService,
    AuthService,
    CryptoService,
    CatalogService,
    BrandingService,
    AnalyticsService,
    StorefrontService,
    InventoryService,
    PaymentsService,
    OrderingService,
    MediaService,
    RealtimeGateway,
    NotificationService,
    SchedulerService,
    whatsappProvider,
    pushProvider,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
  ],
  exports: [Database, NotificationService, OrderingService],
})
export class AppModule {}
