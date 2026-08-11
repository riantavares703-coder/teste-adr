import { Link } from 'react-router-dom';
import { EmptyState, Price, Row } from '@plataforma/ui-web';
import { useCart } from '../cart-context';

export function CartPage() {
  const { cart, subtotalCents, changeQty, remove } = useCart();

  if (cart.lines.length === 0) {
    return (
      <main className="store">
        <EmptyState
          icon="🛒"
          title="Seu carrinho está vazio"
          description="Escolha alguma coisa no cardápio para começar."
          action={
            <Link className="ui-btn ui-btn--primary" to="..">
              Ver cardápio
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="store">
      <div className="ui-section-header">
        <h2>Seu pedido</h2>
        <Link className="ui-btn ui-btn--ghost" to="..">
          Adicionar mais
        </Link>
      </div>

      <ul className="store__lines">
        {cart.lines.map((line) => (
          <li key={line.key} className="ui-card store__line">
            <div className="store__line-body">
              <strong>{line.name}</strong>
              {line.options.length > 0 ? (
                <small>{line.options.map((o) => o.name).join(', ')}</small>
              ) : null}
              {line.notes ? <small>Obs.: {line.notes}</small> : null}
              <Price cents={line.unitPriceCents * line.quantity} />
            </div>

            <div className="store__qty" role="group" aria-label={`Quantidade de ${line.name}`}>
              <button
                type="button"
                className="ui-btn ui-btn--secondary"
                aria-label={`Diminuir ${line.name}`}
                onClick={() => changeQty(line.key, -1)}
              >
                −
              </button>
              {/* aria-live: quem usa leitor de tela precisa ouvir o novo valor
                  sem ter de navegar de volta até o número. */}
              <span aria-live="polite">{line.quantity}</span>
              <button
                type="button"
                className="ui-btn ui-btn--secondary"
                aria-label={`Aumentar ${line.name}`}
                // O estoque é do servidor; aqui só evitamos o clique inútil.
                disabled={line.maxQuantity !== null && line.quantity >= line.maxQuantity}
                onClick={() => changeQty(line.key, 1)}
              >
                +
              </button>
              <button
                type="button"
                className="ui-btn ui-btn--ghost"
                onClick={() => remove(line.key)}
              >
                Remover
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="ui-card">
        <Row label="Subtotal" value={<Price cents={subtotalCents} />} />
        <small>A taxa de entrega, quando houver, é calculada na próxima etapa.</small>
      </div>

      <div className="store__bar">
        <Link className="ui-btn ui-btn--primary ui-btn--full" to="../checkout">
          Continuar
        </Link>
      </div>
    </main>
  );
}
