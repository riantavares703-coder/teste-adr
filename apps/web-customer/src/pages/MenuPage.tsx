import { Link } from 'react-router-dom';
import type { MenuProduct } from '@plataforma/client';
import { Badge, Price } from '@plataforma/ui-web';
import { useStore } from '../store-context';
import { useCart } from '../cart-context';

/**
 * CARDÁPIO.
 *
 * Primeira tela depois do QR code. Precisa responder em segundos, no celular de
 * quem está em pé no balcão: sem carrossel, sem animação de entrada, produto e
 * preço visíveis de imediato.
 */
export function MenuPage() {
  const { menu } = useStore();
  const { count, subtotalCents, add } = useCart();

  const categories = menu.categories.filter((c) => c.products.length > 0);

  return (
    <main className="store">
      <header className="store__header">
        {menu.theme.logoUrl ? (
          <img className="store__logo" src={menu.theme.logoUrl} alt="" />
        ) : null}
        <div>
          <h1>{menu.theme.displayName ?? menu.branch.name}</h1>
          {menu.theme.tagline ? <p>{menu.theme.tagline}</p> : null}
        </div>
      </header>

      {menu.branch.status !== 'ACTIVE' ? (
        <div className="ui-notice ui-notice--warning" role="alert">
          <strong className="ui-notice__title">Loja fechada</strong>
          <div>Você pode ver o cardápio, mas não é possível pedir agora.</div>
        </div>
      ) : null}

      {categories.map((category) => (
        <section key={category.id}>
          <div className="ui-section-header">
            <h2>{category.name}</h2>
          </div>
          <ul className="store__grid">
            {category.products.map((product) => (
              <ProductCard key={product.id} product={product} onAdd={add} />
            ))}
          </ul>
        </section>
      ))}

      {/* Barra fixa: some quando não há nada no carrinho, para não roubar
          espaço vertical num cardápio longo visto no celular. */}
      {count > 0 ? (
        <div className="store__bar">
          <Link className="ui-btn ui-btn--primary ui-btn--full" to="carrinho">
            Ver carrinho · {count} {count === 1 ? 'item' : 'itens'} ·{' '}
            <Price cents={subtotalCents} />
          </Link>
        </div>
      ) : null}
    </main>
  );
}

function ProductCard({
  product,
  onAdd,
}: {
  product: MenuProduct;
  onAdd: ReturnType<typeof useCart>['add'];
}) {
  const { menu, organizationSlug, branchSlug } = useStore();
  const available = product.availability.isPurchasable;

  return (
    <li className={`ui-card store__product ${available ? '' : 'store__product--out'}`}>
      {product.thumbUrl ? (
        <img className="store__thumb" src={product.thumbUrl} alt="" loading="lazy" />
      ) : null}

      <div className="store__product-body">
        <div className="store__product-title">
          <h3>{product.name}</h3>
          {product.isFeatured ? <Badge tone="info">Destaque</Badge> : null}
        </div>
        {product.description ? <p>{product.description}</p> : null}
        <Price cents={product.priceCents} />
      </div>

      <button
        type="button"
        className="ui-btn ui-btn--primary store__add"
        disabled={!available}
        // Rótulo com o nome do produto: numa lista, "Adicionar" repetido
        // dezenas de vezes é inútil para quem usa leitor de tela.
        aria-label={available ? `Adicionar ${product.name}` : `${product.name} indisponível`}
        onClick={() =>
          onAdd({
            product,
            branchId: menu.branch.id,
            organizationSlug,
            branchSlug,
            quantity: 1,
            selectedOptions: [],
          })
        }
      >
        {available ? 'Adicionar' : 'Esgotado'}
      </button>
    </li>
  );
}
