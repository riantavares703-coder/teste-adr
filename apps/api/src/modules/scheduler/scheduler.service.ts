import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { OrderingService } from '../ordering/ordering.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { loadEnv } from '../../config/env.js';

/**
 * Jobs periódicos.
 *
 * Em produção roda como processo separado com lock distribuído (um único
 * scheduler por cluster). Aqui é embutido para desenvolvimento; os testes
 * chamam os métodos diretamente, sem depender de temporizador.
 */
@Injectable()
export class SchedulerService implements OnModuleDestroy {
  private readonly logger = new Logger('Scheduler');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(OrderingService) private readonly ordering: OrderingService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  start(): void {
    if (loadEnv().NODE_ENV === 'test') return;

    // Expiração de reserva: sem este job, um pedido Pix abandonado trancaria o
    // produto para sempre — o risco de maior probabilidade do sistema.
    this.timers.push(
      setInterval(() => {
        void this.ordering
          .expireStaleOrders()
          .then((n) => n > 0 && this.logger.log(`${n} pedido(s) expirado(s)`))
          .catch((e) => this.logger.error(`Expiração falhou: ${(e as Error).message}`));
      }, 30_000),
    );

    // Drenagem do outbox.
    this.timers.push(
      setInterval(() => {
        void this.notifications
          .drainOutbox()
          .catch((e) => this.logger.error(`Outbox falhou: ${(e as Error).message}`));
      }, 2_000),
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
