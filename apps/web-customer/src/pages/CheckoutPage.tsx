import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toOrderItems } from '@plataforma/client';
import type { PaymentMethod } from '@plataforma/domain';
import { Button, Field, Notice, Price, Row, friendlyMessage } from '@plataforma/ui-web';
import { useStore } from '../store-context';
import { useCart } from '../cart-context';
import { maskPhone, toE164 } from '../phone';

const METHOD_LABEL: Record<string, string> = {
  PIX: 'Pix',
  CASH_ON_SITE: 'Dinheiro',
  CREDIT_ON_SITE: 'Crédito na entrega',
  DEBIT_ON_SITE: 'Débito na entrega',
};

/**
 * FECHAMENTO DO PEDIDO.
 *
 * O cliente chegou pelo QR code e não tem conta. Ele se identifica com nome e
 * telefone — o nome para o operador chamar, o telefone para a loja ligar se
 * algo der errado. Nenhum código de verificação: esperar mensagem chegar para
 * pedir um lanche no balcão não fecha.
 *
 * `expectedTotalCents` vai junto SÓ para detectar divergência. Quem cobra é o
 * servidor, que recalcula tudo do zero.
 */
export function CheckoutPage() {
  const { api, menu } = useStore();
  const { cart, subtotalCents, clear } = useCart();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>(
    menu.branch.acceptsPickup ? 'PICKUP' : 'DELIVERY',
  );
  const [method, setMethod] = useState<PaymentMethod>(
    (menu.settings?.enabledPaymentMethods?.[0] as PaymentMethod) ?? 'PIX',
  );
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; phone?: string }>({});

  const methods = menu.settings?.enabledPaymentMethods ?? ['PIX'];

  async function submit() {
    const e164 = toE164(phone);
    const problems: typeof fieldErrors = {};
    if (name.trim().length < 2) problems.name = 'Informe seu nome';
    if (!e164) problems.phone = 'Informe um telefone com DDD';
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setSubmitting(true);
    setError(null);
    try {
      // Sessão de convidado primeiro: o pedido exige um cliente identificado,
      // mesmo que o telefone não seja verificado.
      await api.startGuestSession({ phone: e164!, fullName: name.trim() });

      const created = await api.createOrder(
        {
          branchId: menu.branch.id,
          fulfillment,
          paymentMethod: method,
          items: toOrderItems(cart),
          customerNotes: notes.trim() || undefined,
          expectedTotalCents: subtotalCents,
        },
        // Chave por TENTATIVA: se a resposta se perder na rede e o cliente
        // tocar de novo, o servidor devolve o MESMO pedido em vez de criar um
        // segundo e reservar estoque duas vezes.
        idempotencyKey(),
      );

      clear();
      navigate(`../pedido/${created.order.id}`, { replace: true });
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (cart.lines.length === 0) {
    return (
      <main className="store">
        <Notice tone="info" title="Carrinho vazio">
          <Link to="..">Voltar ao cardápio</Link>
        </Notice>
      </main>
    );
  }

  return (
    <main className="store">
      <div className="ui-section-header">
        <h2>Finalizar pedido</h2>
        <Link className="ui-btn ui-btn--ghost" to="../carrinho">
          Voltar
        </Link>
      </div>

      <div className="ui-card">
        <Field
          label="Seu nome"
          value={name}
          error={fieldErrors.name}
          autoComplete="name"
          placeholder="Como devemos chamar você"
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Telefone"
          value={phone}
          error={fieldErrors.phone}
          inputMode="tel"
          autoComplete="tel"
          placeholder="(11) 98765-4321"
          hint="Só para a loja falar com você sobre este pedido."
          onChange={(e) => setPhone(maskPhone(e.target.value))}
        />
      </div>

      <fieldset className="ui-card store__fieldset">
        <legend>Como quer receber</legend>
        {menu.branch.acceptsPickup ? (
          <label className="store__choice">
            <input
              type="radio"
              name="fulfillment"
              checked={fulfillment === 'PICKUP'}
              onChange={() => setFulfillment('PICKUP')}
            />
            <span>Retirar em {menu.branch.name}</span>
          </label>
        ) : null}
        {menu.branch.acceptsDelivery ? (
          <label className="store__choice">
            <input
              type="radio"
              name="fulfillment"
              checked={fulfillment === 'DELIVERY'}
              onChange={() => setFulfillment('DELIVERY')}
            />
            <span>Entrega</span>
          </label>
        ) : null}
      </fieldset>

      <fieldset className="ui-card store__fieldset">
        <legend>Pagamento</legend>
        {methods.map((m) => (
          <label key={m} className="store__choice">
            <input
              type="radio"
              name="payment"
              checked={method === m}
              onChange={() => setMethod(m as PaymentMethod)}
            />
            <span>{METHOD_LABEL[m] ?? m}</span>
          </label>
        ))}
      </fieldset>

      <div className="ui-card">
        <Field
          label="Observação (opcional)"
          value={notes}
          maxLength={500}
          placeholder="Ex.: sem cebola"
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="ui-card">
        {cart.lines.map((line) => (
          <Row
            key={line.key}
            label={`${line.quantity}× ${line.name}`}
            value={<Price cents={line.unitPriceCents * line.quantity} />}
          />
        ))}
        <Row label="Subtotal" value={<Price cents={subtotalCents} />} />
        <small>O total final, com taxa de entrega, é calculado pela loja.</small>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className="store__bar">
        <Button full loading={submitting} onClick={() => void submit()}>
          Enviar pedido
        </Button>
      </div>
    </main>
  );
}

/**
 * `crypto.randomUUID` exige contexto seguro, e a loja roda em HTTP na rede
 * local. Não precisa ser imprevisível — precisa ser ÚNICA por tentativa.
 */
function idempotencyKey(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
