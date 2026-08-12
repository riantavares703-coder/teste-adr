import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MenuProduct } from '@plataforma/client';
import { describeOpenState } from '@plataforma/domain';
import { Price, Skeleton } from '@plataforma/ui-web';
import { useStore } from '../store-context';
import { useCart } from '../cart-context';
import { ProductSheet } from '../components/ProductSheet';

/**
 * CARDÁPIO.
 *
 * Primeira tela depois do QR code, quase sempre num celular, quase sempre com
 * alguém de pé. Três decisões carregam o resto:
 *
 *  1. As seções ficam FIXAS no topo e acompanham a rolagem. Num cardápio de
 *     cinquenta itens, rolar procurando "Bebidas" é o atrito principal.
 *  2. Produto com opções abre uma FOLHA, não outra página: escolher o tamanho
 *     não deveria custar o lugar da rolagem.
 *  3. A barra do carrinho só aparece quando há algo nele, e cresce ao receber
 *     item — a confirmação de que o toque funcionou.
 */
export function MenuPage() {
  const { menu } = useStore();
  const { count, subtotalCents, add } = useCart();

  const [openProduct, setOpenProduct] = useState<MenuProduct | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [bumped, setBumped] = useState(false);

  const categories = useMemo(
    () => menu.categories.filter((category) => category.products.length > 0),
    [menu.categories],
  );

  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const canOrder = menu.open.isOpen && menu.branch.status === 'ACTIVE';

  /**
   * Marca a seção visível conforme a página rola.
   *
   * A margem superior desconta o cabeçalho fixo: sem ela, a seção só é
   * considerada ativa quando já passou por baixo da barra, e o destaque fica
   * sempre uma seção atrasado.
   */
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveCategory(visible.target.id.replace('secao-', ''));
      },
      { rootMargin: '-140px 0px -70% 0px', threshold: 0 },
    );

    for (const element of sectionRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [categories]);

  function addProduct(product: MenuProduct) {
    if (product.hasOptions) {
      setOpenProduct(product);
      return;
    }
    add({
      product,
      branchId: menu.branch.id,
      organizationSlug: menu.branch.slug,
      branchSlug: menu.branch.slug,
      quantity: 1,
      selectedOptions: [],
    });
    setBumped(true);
    setTimeout(() => setBumped(false), 400);
  }

  function scrollToCategory(id: string) {
    sectionRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <main className="menu">
      <header className="menu__hero">
        <div className="menu__hero-bg" aria-hidden="true" />
        <div className="menu__hero-content">
          {menu.theme.logoUrl ? (
            <img className="menu__logo" src={menu.theme.logoUrl} alt="" />
          ) : (
            <div className="menu__logo menu__logo--letter" aria-hidden="true">
              {(menu.theme.displayName ?? menu.branch.name).charAt(0)}
            </div>
          )}

          <div className="menu__hero-text">
            <h1>{menu.theme.displayName ?? menu.branch.name}</h1>
            {menu.theme.tagline ? <p>{menu.theme.tagline}</p> : null}

            <div className="menu__meta">
              <span className={`menu__dot ${canOrder ? 'menu__dot--open' : 'menu__dot--closed'}`} />
              <span>{canOrder ? describeOpenState(menu.open) : 'Fechada agora'}</span>
              {menu.settings ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{menu.settings.preparationTimeMinutes} min de preparo</span>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {!canOrder ? (
        <div className="menu__closed" role="status">
          <strong>A loja está fechada</strong>
          <span>
            {menu.branch.status !== 'ACTIVE'
              ? 'Não estamos aceitando pedidos no momento.'
              : describeOpenState(menu.open)}{' '}
            Você pode ver o cardápio à vontade.
          </span>
        </div>
      ) : null}

      {categories.length > 1 ? (
        <nav className="menu__nav" aria-label="Seções do cardápio">
          <ul>
            {categories.map((category) => (
              <li key={category.id}>
                <button
                  type="button"
                  className={activeCategory === category.id ? 'menu__tab menu__tab--on' : 'menu__tab'}
                  aria-current={activeCategory === category.id ? 'true' : undefined}
                  onClick={() => scrollToCategory(category.id)}
                >
                  {category.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {categories.map((category) => (
        <section
          key={category.id}
          id={`secao-${category.id}`}
          ref={(element) => {
            if (element) sectionRefs.current.set(category.id, element);
            else sectionRefs.current.delete(category.id);
          }}
          className="menu__section"
          aria-labelledby={`titulo-${category.id}`}
        >
          <h2 id={`titulo-${category.id}`} className="menu__section-title">
            {category.name}
          </h2>

          <ul className="menu__grid">
            {category.products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                disabled={!canOrder}
                onPick={() => addProduct(product)}
              />
            ))}
          </ul>
        </section>
      ))}

      {count > 0 ? (
        <div className="menu__cartbar">
          <Link className={`menu__cartlink ${bumped ? 'menu__cartlink--bump' : ''}`} to="carrinho">
            <span className="menu__cartcount">{count}</span>
            <span className="menu__cartlabel">Ver carrinho</span>
            <Price cents={subtotalCents} />
          </Link>
        </div>
      ) : null}

      <ProductSheet
        product={openProduct}
        onClose={() => setOpenProduct(null)}
        onAdded={() => {
          setOpenProduct(null);
          setBumped(true);
          setTimeout(() => setBumped(false), 400);
        }}
      />
    </main>
  );
}

function ProductCard({
  product,
  disabled,
  onPick,
}: {
  product: MenuProduct;
  disabled: boolean;
  onPick: () => void;
}) {
  const available = product.availability.isPurchasable;
  const blocked = disabled || !available;

  return (
    <li>
      {/*
       * O cartão INTEIRO é o alvo, não só um botão no canto. Num celular, o
       * polegar acerta um retângulo grande; um botão de 44px exige mira.
       */}
      <button
        type="button"
        className={`card ${blocked ? 'card--blocked' : ''}`}
        disabled={blocked}
        aria-label={
          !available
            ? `${product.name}, esgotado`
            : product.hasOptions
              ? `${product.name}, escolher opções`
              : `Adicionar ${product.name}`
        }
        onClick={onPick}
      >
        <div className="card__body">
          <div className="card__head">
            <h3>{product.name}</h3>
            {product.isFeatured ? <span className="card__star" aria-label="Destaque">★</span> : null}
          </div>

          {product.description ? <p className="card__desc">{product.description}</p> : null}

          <div className="card__foot">
            <Price cents={product.priceCents} className="card__price" />
            {product.hasOptions ? <span className="card__hint">escolher</span> : null}
          </div>
        </div>

        {product.thumbUrl ? (
          <img className="card__img" src={product.thumbUrl} alt="" loading="lazy" />
        ) : null}

        {!available ? <span className="card__soldout">Esgotado</span> : null}

        {!blocked ? (
          <span className="card__plus" aria-hidden="true">
            +
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** Esqueleto do cardápio, com a mesma forma dos cartões reais. */
export function MenuSkeleton() {
  return (
    <main className="menu">
      <div className="menu__hero menu__hero--skeleton" />
      <div className="menu__section">
        <Skeleton width={140} height={24} />
        <ul className="menu__grid">
          {[0, 1, 2, 3].map((index) => (
            <li key={index}>
              <div className="card card--skeleton">
                <div className="card__body">
                  <Skeleton width="70%" height={18} />
                  <Skeleton width="90%" height={14} />
                  <Skeleton width={80} height={18} />
                </div>
                <Skeleton width={92} height={92} radius={14} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
