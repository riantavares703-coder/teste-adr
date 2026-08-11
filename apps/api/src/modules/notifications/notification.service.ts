import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';

import { and, eq, sql } from 'drizzle-orm';
import { formatBRL, ORDER_STATUS_LABEL, type OrderStatus } from '@plataforma/domain';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { OutboxService } from './outbox.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import {
  LoggingWhatsAppProvider,
  type WhatsAppProvider,
} from './whatsapp.provider.js';
import { LoggingPushProvider, type PushProvider } from './push.provider.js';

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/**
 * Templates do fluxo de pedido (item 13 do Prompt 02).
 * Categoria UTILITY na Meta — transacional, não marketing.
 *
 * O mapeamento status -> template é DADO, não código: em produção ele vive em
 * `whatsapp_integrations.template_map`, configurável por organização, porque a
 * aprovação de template pela Meta não pode estar no caminho de um deploy.
 */
export const ORDER_TEMPLATES: Partial<
  Record<OrderStatus | 'CREATED', { name: string; language: string; text: (v: TemplateVars) => string }>
> = {
  CREATED: {
    name: 'pedido_recebido',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber} recebido em ${v.branchName}! Valor: ${v.total}.`,
  },
  CONFIRMED: {
    name: 'pedido_confirmado',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber} confirmado! Valor: ${v.total}.`,
  },
  PREPARING: {
    name: 'pedido_em_preparacao',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber}: em preparação.`,
  },
  READY: {
    name: 'pedido_pronto',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber} está pronto!`,
  },
  AWAITING_PICKUP: {
    name: 'pedido_pronto_retirada',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber} pronto para retirada em ${v.branchName}!`,
  },
  OUT_FOR_DELIVERY: {
    name: 'pedido_em_rota',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber} saiu para entrega.`,
  },
  DELIVERED: {
    name: 'pedido_entregue',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber} entregue. Obrigado pela preferência!`,
  },
  PICKED_UP: {
    name: 'pedido_entregue',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber} retirado. Obrigado pela preferência!`,
  },
  CANCELLED: {
    name: 'pedido_cancelado',
    language: 'pt_BR',
    text: (v) => `Pedido #${v.orderNumber} cancelado.`,
  },
};

export interface TemplateVars {
  orderNumber: string;
  branchName: string;
  total: string;
  status: string;
}

/**
 * NotificationService — a camada que o item 13 pede:
 *   NotificationService -> WhatsAppProvider
 *
 * O banco NUNCA fala com a API do WhatsApp. O caminho é:
 *   transação de negócio -> outbox_events -> relay -> NotificationService -> Provider
 *
 * Se o provedor estiver fora do ar (ou não configurado), o pedido já foi
 * comitado e continua funcionando: a notificação fica registrada como FAILED
 * ou SKIPPED, com motivo.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(RealtimeGateway) private readonly realtime: RealtimeGateway,
    @Optional() @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider = new LoggingWhatsAppProvider(),
    @Optional() @Inject(PUSH_PROVIDER) private readonly push: PushProvider = new LoggingPushProvider(),
  ) {}

  /**
   * Drena o outbox. Em produção roda como worker separado (bulkhead: uma fila
   * travada não consome threads da API). Aqui é chamado pelo scheduler e pelos
   * testes.
   */
  async drainOutbox(limit = 50): Promise<{ processed: number; failed: number }> {
    const events = await this.outbox.claimPending(limit);
    let failed = 0;

    for (const event of events) {
      try {
        await this.handle(event);
        await this.outbox.markPublished(event.id);
      } catch (error) {
        failed += 1;
        this.logger.error(`Evento ${event.event_type} falhou: ${(error as Error).message}`);
        await this.outbox.markFailed(event.id, event.attempts, (error as Error).message);
      }
    }

    return { processed: events.length - failed, failed };
  }

  private async handle(event: {
    event_type: string;
    aggregate_id: string;
    organization_id: string | null;
    branch_id: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    switch (event.event_type) {
      case 'order.created':
        // Tempo real primeiro: o operador precisa ver o pedido chegar.
        this.realtime.emitToBranch(event.branch_id!, 'order.created', event.payload);
        await this.notifyOrderStatus(event.aggregate_id, 'CREATED');
        break;

      case 'order.status_changed': {
        const to = event.payload.to as OrderStatus;
        this.realtime.emitToBranch(event.branch_id!, 'order.status_changed', event.payload);
        this.realtime.emitToOrder(event.aggregate_id, 'order.status_changed', event.payload);
        await this.notifyOrderStatus(event.aggregate_id, to);
        break;
      }

      case 'payment.confirmed':
        this.realtime.emitToBranch(event.branch_id!, 'payment.confirmed', event.payload);
        this.realtime.emitToOrder(event.payload.orderId as string, 'payment.confirmed', event.payload);
        break;

      case 'inventory.sold_out':
      case 'inventory.reactivated':
      case 'inventory.adjusted':
      case 'catalog.changed':
        this.realtime.emitToBranch(event.branch_id!, event.event_type, event.payload);
        break;

      default:
        this.logger.debug(`Evento sem consumidor: ${event.event_type}`);
    }
  }

  private async notifyOrderStatus(orderId: string, key: OrderStatus | 'CREATED'): Promise<void> {
    const template = ORDER_TEMPLATES[key];
    if (!template) return;

    const rows = await this.db.platform
      .select({
        order: s.orders,
        branchName: s.branches.name,
        customerPhone: s.users.phoneE164,
        customerId: s.users.id,
      })
      .from(s.orders)
      .innerJoin(s.branches, eq(s.branches.id, s.orders.branchId))
      .innerJoin(s.users, eq(s.users.id, s.orders.customerId))
      .where(eq(s.orders.id, orderId))
      .limit(1);

    const found = rows[0];
    if (!found) return;

    const vars: TemplateVars = {
      orderNumber: found.order.orderNumber,
      branchName: found.branchName,
      total: formatBRL(found.order.totalCents),
      status: ORDER_STATUS_LABEL[found.order.status],
    };

    await this.sendPush(found.customerId, orderId, template.text(vars), vars);
    await this.sendWhatsApp(found, template, vars, orderId);
  }

  private async sendPush(
    customerId: string,
    orderId: string,
    body: string,
    vars: TemplateVars,
  ): Promise<void> {
    const tokens = await this.db.platform
      .select({ token: s.deviceTokens.token })
      .from(s.deviceTokens)
      .where(and(eq(s.deviceTokens.userId, customerId), eq(s.deviceTokens.isActive, true)));

    const result = await this.push.send({
      tokens: tokens.map((t) => t.token),
      title: `Pedido #${vars.orderNumber}`,
      body,
      // Gatilho, não portador: o app busca o estado real por REST.
      data: { orderId, type: 'ORDER_STATUS' },
    });

    if (result.status === 'FAILED') {
      this.logger.warn(`Push falhou: ${result.reason}`);
    }
  }

  private async sendWhatsApp(
    found: {
      order: typeof s.orders.$inferSelect;
      customerPhone: string | null;
      customerId: string;
    },
    template: { name: string; language: string },
    vars: TemplateVars,
    orderId: string,
  ): Promise<void> {
    if (!found.customerPhone) return;

    // Opt-in é exigência da Meta E da LGPD. Sem consentimento, não enviamos —
    // a notificação fica SKIPPED e o cliente recebe por push.
    const link = await this.db.platform
      .select({ optIn: s.customerOrganizationLinks.whatsappOptIn })
      .from(s.customerOrganizationLinks)
      .where(
        and(
          eq(s.customerOrganizationLinks.customerId, found.customerId),
          eq(s.customerOrganizationLinks.organizationId, found.order.organizationId),
        ),
      )
      .limit(1);

    const notificationId = uuidv7();
    const optedIn = link[0]?.optIn === true;

    const insertNotification = async (
      status: 'SENT' | 'SKIPPED' | 'FAILED',
      providerMessageId: string | null,
      failureReason: string | null,
    ) => {
      // ON CONFLICT: o outbox é at-least-once. Sem deduplicação, um evento
      // reprocessado enviaria a mesma mensagem duas vezes ao cliente.
      await this.db.platform.execute(sql`
        INSERT INTO notifications
          (id, organization_id, branch_id, order_id, recipient_user_id, recipient_address,
           channel, template_name, template_variables, status, provider, provider_message_id,
           attempts, failure_reason, sent_at)
        VALUES (${notificationId}, ${found.order.organizationId}, ${found.order.branchId},
                ${orderId}, ${found.customerId}, ${found.customerPhone},
                'WHATSAPP', ${template.name}, ${JSON.stringify(vars)}::jsonb, ${status},
                ${this.whatsapp.code}, ${providerMessageId}, 1, ${failureReason},
                ${status === 'SENT' ? sql`now()` : null})
        ON CONFLICT (order_id, template_name, channel) WHERE order_id IS NOT NULL
        DO NOTHING
      `);
    };

    if (!optedIn) {
      await insertNotification('SKIPPED', null, 'SEM_OPT_IN_WHATSAPP');
      return;
    }

    const result = await this.whatsapp.send({
      toPhoneE164: found.customerPhone,
      templateName: template.name,
      languageCode: template.language,
      variables: [vars.orderNumber, vars.branchName, vars.total],
      idempotencyKey: `${orderId}:${template.name}`,
    });

    if (result.status === 'SENT') {
      await insertNotification('SENT', result.providerMessageId, null);
    } else if (result.status === 'SKIPPED') {
      await insertNotification('SKIPPED', null, result.reason);
    } else {
      await insertNotification('FAILED', null, result.reason);
      if (result.retryable) throw new Error(`WhatsApp falhou: ${result.reason}`);
    }
  }
}
