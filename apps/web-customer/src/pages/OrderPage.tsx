import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { OrderDetail } from '@plataforma/client';
import { AsyncBoundary, Badge, Price, Row, useRealtime, type Tone } from '@plataforma/ui-web';
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

/** Estados em que o preparo está de fato correndo. */
const PREPARING = new Set(['CONFIRMED', 'PREPARING']);

/**
 * BARRA DE PREPARO.
 *
 * A previsão vem do servidor (`estimatedReadyAt`, derivada do tempo de preparo
 * que a loja cadastrou). O app só desenha — não estima nada, nem consulta o
 * relógio para decidir se está pronto: quem diz que ficou pronto é o operador,
 * mudando o status.
 *
 * Por isso a barra PARA em 95% em vez de completar sozinha. Chegar a 100% e o
 * pedido continuar "em preparo" seria uma promessa que a tela não pode cumprir.
 */
function PreparationBar({ order }: { order: OrderDetail['order'] }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!PREPARING.has(order.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [order.status]);

  if (!PREPARING.has(order.status) || !order.estimatedReadyAt) return null;

  const start = new Date(order.confirmedAt ?? order.placedAt).getTime();
  const end = new Date(order.estimatedReadyAt).getTime();
  const total = end - start;
  if (total <= 0) return null;

  const elapsed = Math.max(0, now - start);
  const percent = Math.min(95, Math.round((elapsed / total) * 100));
  const remaining = Math.max(0, Math.ceil((end - now) / 60_000));

  return (
    <div className="prep">
      <div
        className="prep__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Progresso do preparo"
      >
        <div className="prep__fill" style={{ width: `${percent}%` }} />
      </div>
      <small>
        {remaining > 0
          ? `Previsão: pronto em cerca de ${remaining} min`
          : 'Deve ficar pronto a qualquer momento'}
      </small>
    </div>
  );
}

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

  /*
   * Tempo real: o cliente vê "saiu para entrega" no instante em que o operador
   * toca o botão, não até 15 segundos depois.
   *
   * O evento serve de GATILHO, não de fonte: em vez de aplicar o payload na
   * tela, recarregamos o pedido. Assim existe uma única forma de montar esta
   * tela, e uma mensagem fora de ordem ou incompleta não pinta um estado que o
   * servidor não tem.
   */
  const connection = useRealtime(
    () => api.currentAccessToken,
    order && !FINAL.has(order.order.status) ? { orderId: order.order.id } : {},
    () => void load(),
  );

  // Rede de segurança, bem mais espaçada que antes: se o socket cair no meio do
  // preparo, a tela não pode congelar em silêncio.
  useEffect(() => {
    if (!order || FINAL.has(order.order.status)) return;
    const period = connection === 'conectado' ? 60_000 : 12_000;
    const timer = setInterval(() => void load(), period);
    return () => clearInterval(timer);
  }, [order, load, connection]);

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

              <PreparationBar order={order.order} />
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
