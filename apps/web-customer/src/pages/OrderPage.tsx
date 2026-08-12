import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { OrderDetail } from '@plataforma/client';
import { AsyncBoundary, Badge, Price, Row, type Tone } from '@plataforma/ui-web';
import { useStore } from '../store-context';

/**
 * ACOMPANHAMENTO.
 *
 * Duas máquinas de estado lado a lado, nunca fundidas: o pedido tem um estado
 * (`PREPARING`) e o pagamento tem outro (`AWAITING_CONFIRMATION`). "Aguardando
 * pagamento" é a combinação dos dois, derivada aqui — não um estado gravado.
 */
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Recebido, aguardando a loja',
  CONFIRMED: 'Confirmado pela loja',
  PREPARING: 'Em preparo',
  READY: 'Pronto',
  AWAITING_PICKUP: 'Pronto para retirada',
  OUT_FOR_DELIVERY: 'Saiu para entrega',
  PICKED_UP: 'Retirado',
  DELIVERED: 'Entregue',
  CANCELLED: 'Cancelado',
  REJECTED: 'Recusado pela loja',
  EXPIRED: 'Expirado',
};

const STATUS_TONE: Record<string, Tone> = {
  CANCELLED: 'danger',
  REJECTED: 'danger',
  EXPIRED: 'danger',
  DELIVERED: 'success',
  PICKED_UP: 'success',
  READY: 'success',
  AWAITING_PICKUP: 'success',
};

/** Estados finais: parar de perguntar ao servidor o que não muda mais. */
const FINAL = new Set(['DELIVERED', 'PICKED_UP', 'CANCELLED', 'REJECTED', 'EXPIRED']);

export function OrderPage() {
  const { orderId } = useParams();
  const { api } = useStore();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      setOrder(await api.getOrder(orderId));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Consulta periódica em vez de WebSocket: são poucos clientes por loja e o
  // custo é irrelevante, mas uma conexão persistente a mais teria de sobreviver
  // a tela bloqueada, troca de rede e aba em segundo plano.
  useEffect(() => {
    if (!order || FINAL.has(order.order.status)) return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [order, load]);

  return (
    <main className="store">
      <AsyncBoundary loading={loading} error={error} onRetry={() => void load()}>
        {order ? (
          <>
            <div className="ui-card store__status">
              <span className="store__number">#{order.order.orderNumber}</span>
              <Badge tone={STATUS_TONE[order.order.status] ?? 'info'}>
                {STATUS_LABEL[order.order.status] ?? order.order.status}
              </Badge>
              {order.payment && order.payment.status !== 'CONFIRMED' ? (
                <small>
                  Pagamento:{' '}
                  {order.payment.status === 'PENDING'
                    ? 'na entrega'
                    : 'aguardando confirmação da loja'}
                </small>
              ) : null}
            </div>

            <div className="ui-card">
              {order.items.map((item) => (
                <Row
                  key={item.id}
                  // Nome do SNAPSHOT: se a loja renomear o produto depois, o
                  // pedido continua mostrando o que o cliente comprou.
                  label={`${item.quantity}× ${item.productNameSnapshot}`}
                  value={<Price cents={item.lineTotalCents} />}
                />
              ))}
              <Row label="Total" value={<Price cents={order.order.totalCents} />} />
            </div>

            {order.order.customerNotes ? (
              <div className="ui-card">
                <strong>Observação</strong>
                <p>{order.order.customerNotes}</p>
              </div>
            ) : null}

            <p className="store__hint">
              Esta página se atualiza sozinha. Guarde o número <strong>#{order.order.orderNumber}</strong> para
              retirar no balcão.
            </p>

            <Link className="ui-btn ui-btn--secondary" to="../..">
              Voltar ao cardápio
            </Link>
          </>
        ) : null}
      </AsyncBoundary>
    </main>
  );
}
