import { useCallback, useEffect, useState } from 'react';
import type { OrderDetail } from '@plataforma/client';
import {
  ORDER_STATUS_LABEL,
  nextStatuses,
  type OrderStatus,
} from '@plataforma/domain';
import {
  AsyncBoundary,
  Badge,
  Button,
  EmptyState,
  Price,
  friendlyMessage,
  type Tone,
} from '@plataforma/ui-web';
import { useSession } from '../session';

/**
 * FILA DE PEDIDOS — a tela que fica aberta o dia inteiro no balcão.
 *
 * Os botões de transição vêm de `nextStatuses()`, do domínio: a MESMA regra que
 * o servidor aplica ao recusar uma transição inválida. Uma lista de botões
 * escrita à mão aqui seria uma segunda máquina de estados, livre para divergir.
 */
const TONE: Partial<Record<OrderStatus, Tone>> = {
  PENDING: 'warning',
  CONFIRMED: 'info',
  PREPARING: 'info',
  READY: 'success',
  AWAITING_PICKUP: 'success',
  OUT_FOR_DELIVERY: 'info',
  DELIVERED: 'success',
  PICKED_UP: 'success',
  CANCELLED: 'danger',
  REJECTED: 'danger',
  EXPIRED: 'danger',
};

/** Quanto tempo um pedido pode esperar antes de virar problema. */
const LATE_AFTER_MINUTES = 20;

export function OrdersPage() {
  const { api, branch, can } = useSession();

  const [orders, setOrders] = useState<OrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrders(await api.listBranchOrders(branch.id));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, branch.id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // O operador não fica apertando atualizar: a fila se renova sozinha.
  useEffect(() => {
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function move(order: OrderDetail, to: OrderStatus) {
    setWorking(order.order.id);
    setActionError(null);
    try {
      await api.transitionOrder(branch.id, order.order.id, to);
      await load();
    } catch (e) {
      setActionError(friendlyMessage(e));
    } finally {
      setWorking(null);
    }
  }

  const active = orders.filter(
    (o) => !['DELIVERED', 'PICKED_UP', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.order.status),
  );

  return (
    <section>
      <div className="ui-section-header">
        <h2>Fila de pedidos</h2>
        <Button variant="secondary" onClick={() => void load()}>
          Atualizar
        </Button>
      </div>

      {actionError ? <div className="ui-notice ui-notice--danger" role="alert">{actionError}</div> : null}

      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={() => void load()}
        isEmpty={active.length === 0}
        empty={
          <EmptyState
            icon="🧾"
            title="Nenhum pedido aberto"
            description="Os pedidos aparecem aqui assim que os clientes enviam."
          />
        }
      >
        <ul className="queue">
          {active.map((detail) => {
            const { order, items, payment } = detail;
            const minutes = Math.floor(
              (Date.now() - new Date(order.placedAt).getTime()) / 60_000,
            );
            const late = minutes >= LATE_AFTER_MINUTES;
            const options = can('order:transition')
              ? nextStatuses(order.status, order.fulfillment)
              : [];

            return (
              <li key={order.id} className={`ui-card queue__item ${late ? 'queue__item--late' : ''}`}>
                <div className="queue__head">
                  <strong className="queue__number">#{order.orderNumber}</strong>
                  <Badge tone={TONE[order.status] ?? 'neutral'}>
                    {ORDER_STATUS_LABEL[order.status]}
                  </Badge>
                  <Badge tone={order.fulfillment === 'DELIVERY' ? 'info' : 'neutral'}>
                    {order.fulfillment === 'DELIVERY' ? 'Entrega' : 'Retirada'}
                  </Badge>
                  {/* Pagamento é máquina de estado SEPARADA do pedido: um
                      pedido pode estar em preparo com pagamento pendente. */}
                  {payment && payment.status !== 'CONFIRMED' ? (
                    <Badge tone="warning">
                      {payment.method === 'PIX' ? 'Pix não confirmado' : 'Paga na entrega'}
                    </Badge>
                  ) : null}
                  <span className={`queue__age ${late ? 'queue__age--late' : ''}`}>
                    {minutes} min
                  </span>
                </div>

                <ul className="queue__items">
                  {items.map((item) => (
                    <li key={item.id}>
                      {item.quantity}× {item.productNameSnapshot}
                      {item.notes ? <em> — {item.notes}</em> : null}
                    </li>
                  ))}
                </ul>

                {order.customerNotes ? (
                  <p className="queue__notes">Observação: {order.customerNotes}</p>
                ) : null}

                <div className="queue__foot">
                  <Price cents={order.totalCents} />
                  <div className="queue__actions">
                    {options.map((to) => (
                      <Button
                        key={to}
                        variant={to === 'CANCELLED' || to === 'REJECTED' ? 'danger' : 'primary'}
                        loading={working === order.id}
                        onClick={() => void move(detail, to)}
                      >
                        {ORDER_STATUS_LABEL[to]}
                      </Button>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </AsyncBoundary>
    </section>
  );
}
