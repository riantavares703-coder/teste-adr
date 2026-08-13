import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import type { OrderDetail, PaymentView } from '@plataforma/client';
import { PAYMENT_METHOD_LABEL } from '@plataforma/domain';
import { AsyncBoundary, Badge, Price, Row, Skeleton, useRealtime, type Tone } from '@plataforma/ui-web';
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

/**
 * PAGAMENTO.
 *
 * Um BR Code Pix estático não avisa ninguém quando o dinheiro cai — só a loja
 * confirmando manualmente muda este cartão (docs/ARQUITETURA-DELTA.md, ADR-0008).
 * Por isso a mensagem nunca promete confirmação automática: ela diz o que
 * realmente vai acontecer, e a tela já está de olho no evento `payment.confirmed`
 * via `useRealtime` — quando a loja confirmar, o cartão troca sozinho.
 */
function PaymentCard({ payment, totalCents }: { payment: PaymentView; totalCents: number }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setQr(null);
    if (payment.method !== 'PIX' || !payment.pixBrcode) return;
    let cancelled = false;
    void QRCode.toDataURL(payment.pixBrcode, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        // Sem QR, o código "copia e cola" abaixo continua funcionando sozinho.
      });
    return () => {
      cancelled = true;
    };
  }, [payment.method, payment.pixBrcode]);

  async function copy() {
    if (!payment.pixBrcode) return;
    try {
      await navigator.clipboard.writeText(payment.pixBrcode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Sem permissão de área de transferência: o código está selecionável na tela.
    }
  }

  if (payment.status === 'CONFIRMED') {
    return (
      <div className="ui-card pay pay--ok">
        <Badge tone="success">Pagamento confirmado</Badge>
      </div>
    );
  }

  if (payment.method !== 'PIX') {
    return (
      <div className="ui-card pay pay--ok">
        <strong>Pagamento: {PAYMENT_METHOD_LABEL[payment.method]}</strong>
        <Row label="Valor a pagar" value={<Price cents={totalCents} />} />
      </div>
    );
  }

  return (
    <div className="ui-card pay">
      <div className="pay__head">
        <strong>Pague com Pix</strong>
        <Price cents={totalCents} />
      </div>

      {qr ? (
        <img className="pay__qr" src={qr} alt="QR code Pix para pagamento" />
      ) : (
        <Skeleton width={200} height={200} radius={14} />
      )}

      <button type="button" className="ui-btn ui-btn--primary pay__copy" onClick={() => void copy()}>
        {copied ? 'Código copiado!' : 'Copiar código Pix'}
      </button>

      <code className="pay__code">{payment.pixBrcode}</code>

      {payment.pixKeyMasked ? <small>Chave da loja: {payment.pixKeyMasked}</small> : null}

      <p className="pay__hint">
        Pague pelo app do seu banco. A loja confirma o recebimento manualmente — esta tela
        atualiza sozinha assim que isso acontecer.
      </p>
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
            </div>

            {order.payment ? (
              <PaymentCard payment={order.payment} totalCents={order.order.totalCents} />
            ) : null}

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
