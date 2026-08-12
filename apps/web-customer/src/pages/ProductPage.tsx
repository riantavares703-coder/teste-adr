import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { validateSelection, type CartOption, type ProductDetail } from '@plataforma/client';
import { AsyncBoundary, Button, Field, Price } from '@plataforma/ui-web';
import { useStore } from '../store-context';
import { useCart } from '../cart-context';

/**
 * PRODUTO COM OPÇÕES.
 *
 * A regra de escolha (obrigatório, mínimo, máximo) vem do servidor junto com o
 * produto e é aplicada por `validateSelection`, do pacote compartilhado — a
 * MESMA função que o checkout usa. Aqui ela serve para desabilitar o botão e
 * explicar o que falta; a recusa de verdade continua no servidor.
 */
export function ProductPage() {
  const { productId } = useParams();
  const { api, menu, organizationSlug, branchSlug } = useStore();
  const { add } = useCart();
  const navigate = useNavigate();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState('');
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    api
      .getProduct(productId)
      .then((loaded) => !cancelled && setProduct(loaded))
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, productId]);

  const chosenOptions = useMemo<CartOption[]>(() => {
    if (!product) return [];
    return product.modifierGroups.flatMap((group) =>
      group.options
        .filter((option) => (selected[group.id] ?? []).includes(option.id))
        .map((option) => ({
          id: option.id,
          name: option.name,
          priceDeltaCents: option.priceDeltaCents,
          groupName: group.name,
        })),
    );
  }, [product, selected]);

  const check = product
    ? validateSelection(
        product.modifierGroups,
        chosenOptions.map((o) => o.id),
      )
    : ({ ok: true } as const);
  const problem = check.ok ? null : check.message;

  const unitPrice = product
    ? product.priceCents + chosenOptions.reduce((sum, o) => sum + o.priceDeltaCents, 0)
    : 0;

  function toggle(groupId: string, optionId: string, maxSelect: number) {
    setSelected((current) => {
      const chosen = current[groupId] ?? [];
      if (chosen.includes(optionId)) {
        return { ...current, [groupId]: chosen.filter((id) => id !== optionId) };
      }
      // Grupo de escolha única troca em vez de acumular — é o comportamento
      // que o cliente espera de um "Tamanho".
      if (maxSelect === 1) return { ...current, [groupId]: [optionId] };
      if (chosen.length >= maxSelect) return current;
      return { ...current, [groupId]: [...chosen, optionId] };
    });
  }

  function addAndReturn() {
    if (!product || problem) return;
    add({
      product: { ...product, categoryId: null, thumbUrl: null } as never,
      branchId: menu.branch.id,
      organizationSlug,
      branchSlug,
      quantity,
      selectedOptions: chosenOptions,
      notes: notes.trim() || undefined,
    });
    navigate('..');
  }

  return (
    <main className="store">
      <AsyncBoundary loading={loading} error={error} onRetry={() => window.location.reload()}>
        {product ? (
          <>
            {product.images[0] ? (
              <img className="store__hero" src={product.images[0].url} alt={product.images[0].altText ?? ''} />
            ) : null}

            <h1>{product.name}</h1>
            {product.description ? <p className="store__desc">{product.description}</p> : null}
            <Price cents={product.priceCents} />

            {product.modifierGroups.map((group) => {
              const chosen = selected[group.id] ?? [];
              return (
                <fieldset key={group.id} className="ui-card store__fieldset">
                  <legend>
                    {group.name}{' '}
                    <span className="store__rule">
                      {group.isRequired ? 'obrigatório' : 'opcional'}
                      {group.maxSelect > 1 ? ` · até ${group.maxSelect}` : ''}
                    </span>
                  </legend>

                  {group.options.map((option) => {
                    const isChosen = chosen.includes(option.id);
                    // Trava só o que ainda NÃO foi escolhido: desmarcar sempre
                    // deve ser possível, senão o cliente fica preso na escolha.
                    const cheio = !isChosen && chosen.length >= group.maxSelect && group.maxSelect > 1;

                    return (
                      <label key={option.id} className="store__choice">
                        <input
                          type={group.maxSelect === 1 ? 'radio' : 'checkbox'}
                          name={group.id}
                          checked={isChosen}
                          disabled={cheio}
                          onChange={() => toggle(group.id, option.id, group.maxSelect)}
                        />
                        <span>{option.name}</span>
                        {option.priceDeltaCents !== 0 ? (
                          <span className="store__delta">
                            {option.priceDeltaCents > 0 ? '+' : '−'}
                            <Price cents={Math.abs(option.priceDeltaCents)} />
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </fieldset>
              );
            })}

            {product.allowsCustomerNotes ? (
              <div className="ui-card">
                <Field
                  label="Observação"
                  value={notes}
                  maxLength={200}
                  placeholder="Ex.: sem cebola"
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            ) : null}

            <div className="ui-card store__qtybox">
              <span>Quantidade</span>
              <div className="store__qty">
                <button
                  type="button"
                  className="ui-btn ui-btn--secondary"
                  aria-label="Diminuir quantidade"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                >
                  −
                </button>
                <span aria-live="polite">{quantity}</span>
                <button
                  type="button"
                  className="ui-btn ui-btn--secondary"
                  aria-label="Aumentar quantidade"
                  onClick={() => setQuantity((q) => q + 1)}
                >
                  +
                </button>
              </div>
            </div>

            {problem ? <div className="ui-notice ui-notice--info">{problem}</div> : null}

            <div className="store__bar">
              <Button
                full
                disabled={problem !== null || !product.availability.isPurchasable}
                onClick={addAndReturn}
              >
                Adicionar · <Price cents={unitPrice * quantity} />
              </Button>
            </div>
          </>
        ) : null}
      </AsyncBoundary>
    </main>
  );
}
