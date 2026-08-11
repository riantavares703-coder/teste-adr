import { Link } from 'react-router-dom';
import { Notice, Price, Row } from '@plataforma/ui-web';
import { useStore } from '../store-context';
import { useCart } from '../cart-context';

/**
 * FECHAMENTO DO PEDIDO.
 *
 * Ainda não envia o pedido: a criação exige a permissão `order:create`, que hoje
 * só existe para cliente autenticado por OTP — e o OTP depende de um provedor de
 * WhatsApp configurado, o que não existe numa instalação de balcão.
 *
 * O resumo abaixo é real; falta decidir COMO o cliente se identifica antes de
 * ligar o envio. Está registrado em REFACTORING.md.
 */
export function CheckoutPage() {
  const { menu } = useStore();
  const { cart, subtotalCents } = useCart();

  return (
    <main className="store">
      <div className="ui-section-header">
        <h2>Conferir pedido</h2>
        <Link className="ui-btn ui-btn--ghost" to="../carrinho">
          Voltar
        </Link>
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
      </div>

      <Notice tone="warning" title="Envio de pedido ainda não habilitado">
        Falta definir como o cliente se identifica ao pedir. Enquanto isso, o
        pedido pode ser anotado no balcão de {menu.branch.name}.
      </Notice>
    </main>
  );
}
