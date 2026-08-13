import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderDetail } from '@plataforma/client';
import { ORDER_STATUS_LABEL, nextStatuses, type OrderStatus } from '@plataforma/domain';
import {
  Button,
  EmptyState,
  ErrorState,
  Price,
  Skeleton,
  friendlyMessage,
  playNewOrderChime,
  useRealtime,
} from '@plataforma/ui-web';
import { useSession } from '../session';

/**
 * FILA DE PEDIDOS — a tela que fica aberta o dia inteiro no balcão.
 *
 * Organizada como um painel de cozinha: colunas por etapa, para que a pergunta
 * "o que falta fazer agora" se responda de longe, sem ler.
 *
 * Os botões de transição vêm de `nextStatuses()`, do domínio: a MESMA regra que
 * o servidor aplica ao recusar. Uma lista escrita à mão aqui seria uma segunda
 * máquina de estados, livre para divergir.
 */
const COLUMNS: Array<{ title: string; statuses: OrderStatus[] }> = [
  { title: 'Novos', statuses: ['PENDING'] },
  { title: 'Em preparo', statuses: ['CONFIRMED', 'PREPARING'] },
  { title: 'Prontos', statuses: ['READY', 'AWAITING_PICKUP'] },
  { title: 'Saíram', statuses: ['OUT_FOR_DELIVERY'] },
];

/** A partir daqui o pedido está demorando e precisa saltar aos olhos. */
const LATE_MINUTES = 20;
const WARN_MINUTES = 12;

export function OrdersPage() {
  const { api, branch, can } = useSession();

  const [orders, setOrders] = useState<OrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);

  // Ids já vistos: sem isso, a primeira carga tocaria o alerta para cada pedido
  // que já estava na fila antes de a tela abrir.
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await api.listBranchOrders(branch.id);
      setOrders(loaded);
      setError(null);

      const ids = new Set(loaded.map((o) => o.order.id));
      if (known.current === null) {
        known.current = ids;
      } else {
        const novos = [...ids].filter((id) => !known.current!.has(id));
        known.current = ids;
        if (novos.length > 0) {
          playNewOrderChime();
          setArrived((current) => new Set([...current, ...novos]));
          // O realce dura o suficiente para o olho encontrar, e sai — senão
          // depois de uma hora a tela inteira está "nova".
          setTimeout(
            () =>
              setArrived((current) => {
                const next = new Set(current);
                for (const id of novos) next.delete(id);
                return next;
              }),
            8000,
          );
        }
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, branch.id]);

  useEffect(() => {
    setLoading(true);
    known.current = null;
    void load();
  }, [load]);

  /* Pedido novo entra na hora, sem esperar o próximo ciclo de consulta. */
  const connection = useRealtime(() => api.currentAccessToken, { branchId: branch.id }, () =>
    void load(),
  );

  // Rede de segurança quando o socket cai, e relógio para o tempo decorrido
  // continuar correndo mesmo sem nenhum evento chegando.
  useEffect(() => {
    const period = connection === 'conectado' ? 45_000 : 8_000;
    const timer = setInterval(() => void load(), period);
    return () => clearInterval(timer);
  }, [load, connection]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

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

  /**
   * Confirma o RECEBIMENTO — máquina de estado separada da do pedido, de
   * propósito: um Pix pode chegar com o pedido já pronto, ou nunca chegar
   * enquanto o pedido segue preparado e entregue normalmente.
   */
  async function confirmPayment(order: OrderDetail) {
    if (!order.payment) return;
    setWorking(order.order.id);
    setActionError(null);
    try {
      await api.confirmPayment(branch.id, order.payment.id);
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

  if (loading) {
    return (
      <div className="board">
        {COLUMNS.map((column) => (
          <section key={column.title} className="board__col">
            <header className="board__colhead">
              <h2>{column.title}</h2>
            </header>
            <Skeleton height={132} radius={20} />
            <Skeleton height={132} radius={20} />
          </section>
        ))}
      </div>
    );
  }

  if (error) return <ErrorState message={friendlyMessage(error)} onRetry={() => void load()} />;

  return (
    <>
      <div className="board__bar">
        <span className={`live live--${connection}`}>
          <span className="live__dot" aria-hidden="true" />
          {connection === 'conectado'
            ? 'Ao vivo'
            : connection === 'conectando'
              ? 'Conectando…'
              : 'Sem conexão ao vivo'}
        </span>
        <span className="board__count tnum">
          {active.length} {active.length === 1 ? 'pedido aberto' : 'pedidos abertos'}
        </span>
      </div>

      {actionError ? (
        <div className="ui-notice ui-notice--danger" role="alert">
          {actionError}
        </div>
      ) : null}

      {active.length === 0 ? (
        <EmptyState
          icon="🧾"
          title="Nenhum pedido aberto"
          description="Assim que um cliente enviar, o pedido aparece aqui na hora."
        />
      ) : (
        <div className="board">
          {COLUMNS.map((column) => {
            const list = active.filter((o) => column.statuses.includes(o.order.status));
            return (
              <section key={column.title} className="board__col">
                <header className="board__colhead">
                  <h2>{column.title}</h2>
                  <span className="board__pill tnum">{list.length}</span>
                </header>

                {list.length === 0 ? (
                  <p className="board__empty">—</p>
                ) : (
                  list.map((detail) => (
                    <OrderCard
                      key={detail.order.id}
                      detail={detail}
                      isNew={arrived.has(detail.order.id)}
                      busy={working === detail.order.id}
                      canMove={can('order:transition')}
                      canConfirmPayment={can('payment:confirm')}
                      onMove={(to) => void move(detail, to)}
                      onConfirmPayment={() => void confirmPayment(detail)}
                    />
                  ))
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function OrderCard({
  detail,
  isNew,
  busy,
  canMove,
  canConfirmPayment,
  onMove,
  onConfirmPayment,
}: {
  detail: OrderDetail;
  isNew: boolean;
  busy: boolean;
  canMove: boolean;
  canConfirmPayment: boolean;
  onMove: (to: OrderStatus) => void;
  onConfirmPayment: () => void;
}) {
  const { order, items, payment } = detail;
  const minutes = Math.floor((Date.now() - new Date(order.placedAt).getTime()) / 60_000);
  const urgency = minutes >= LATE_MINUTES ? 'late' : minutes >= WARN_MINUTES ? 'warn' : 'ok';
  const options = canMove ? nextStatuses(order.status, order.fulfillment) : [];

  // A ação principal é a que avança; cancelar e recusar ficam de lado, com
  // menos peso visual, para não competir com o toque frequente.
  const advance = options.filter((to) => to !== 'CANCELLED' && to !== 'REJECTED');
  const abort = options.filter((to) => to === 'CANCELLED' || to === 'REJECTED');

  return (
    <article className={`ticket ticket--${urgency} ${isNew ? 'ticket--new' : ''}`}>
      <header className="ticket__head">
        <span className="ticket__number tnum">#{order.orderNumber}</span>
        <span className={`ticket__age ticket__age--${urgency} tnum`}>{minutes} min</span>
      </header>

      <div className="ticket__tags">
        <span className="ui-badge">{order.fulfillment === 'DELIVERY' ? 'Entrega' : 'Retirada'}</span>
        {/* Pagamento é máquina de estado SEPARADA do pedido: pode estar em
            preparo com pagamento pendente. */}
        {payment && payment.status !== 'CONFIRMED' ? (
          <>
            <span className="ui-badge ui-badge--warning">
              {payment.method === 'PIX' ? 'Pix não confirmado' : 'Paga na entrega'}
            </span>
            {canConfirmPayment ? (
              <button
                type="button"
                className="ticket__payconfirm"
                disabled={busy}
                onClick={onConfirmPayment}
              >
                Confirmar pagamento
              </button>
            ) : null}
          </>
        ) : (
          <span className="ui-badge ui-badge--success">Pago</span>
        )}
      </div>

      <ul className="ticket__items">
        {items.map((item) => (
          <li key={item.id}>
            <span className="ticket__qty tnum">{item.quantity}×</span>
            <span>{item.productNameSnapshot}</span>
            {item.notes ? <em className="ticket__note">{item.notes}</em> : null}
          </li>
        ))}
      </ul>

      {order.customerNotes ? <p className="ticket__obs">“{order.customerNotes}”</p> : null}

      <footer className="ticket__foot">
        <Price cents={order.totalCents} />
        <div className="ticket__actions">
          {abort.map((to) => (
            <button
              key={to}
              type="button"
              className="ticket__abort"
              disabled={busy}
              onClick={() => onMove(to)}
            >
              {ORDER_STATUS_LABEL[to]}
            </button>
          ))}
          {advance.map((to) => (
            <Button key={to} loading={busy} onClick={() => onMove(to)}>
              {ORDER_STATUS_LABEL[to]}
            </Button>
          ))}
        </div>
      </footer>
    </article>
  );
}
