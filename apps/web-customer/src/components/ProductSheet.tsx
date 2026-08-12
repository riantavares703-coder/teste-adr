import { useEffect, useMemo, useState } from 'react';
import { validateSelection, type CartOption, type MenuProduct, type ProductDetail } from '@plataforma/client';
import { Price, Sheet, Skeleton, friendlyMessage } from '@plataforma/ui-web';
import { useStore } from '../store-context';
import { useCart } from '../cart-context';

/**
 * ESCOLHA DE OPÇÕES, numa folha sobre o cardápio.
 *
 * A regra (obrigatório, mínimo, máximo) vem do servidor e é aplicada por
 * `validateSelection` — a MESMA função que o checkout usa para recusar. Aqui
 * ela serve para desabilitar o botão e dizer o que falta; a recusa de verdade
 * continua no servidor.
 */
export function ProductSheet({
  product,
  onClose,
  onAdded,
}: {
  product: MenuProduct | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { api, menu, organizationSlug, branchSlug } = useStore();
  const { add } = useCart();

  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState('');
  const [quantity, setQuantity] = useState(1);

  // Estado zerado a cada produto: sobra da escolha anterior seria um erro caro,
  // porque o cliente só perceberia no carrinho.
  useEffect(() => {
    setDetail(null);
    setSelected({});
    setNotes('');
    setQuantity(1);
    setError(null);
    if (!product) return;

    let cancelled = false;
    api
      .getProduct(product.id)
      .then((loaded) => !cancelled && setDetail(loaded))
      .catch((e) => !cancelled && setError(friendlyMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [api, product]);

  const chosen = useMemo<CartOption[]>(() => {
    if (!detail) return [];
    return detail.modifierGroups.flatMap((group) =>
      group.options
        .filter((option) => (selected[group.id] ?? []).includes(option.id))
        .map((option) => ({
          id: option.id,
          name: option.name,
          priceDeltaCents: option.priceDeltaCents,
          groupName: group.name,
        })),
    );
  }, [detail, selected]);

  const check = detail
    ? validateSelection(detail.modifierGroups, chosen.map((option) => option.id))
    : ({ ok: true } as const);
  const problem = check.ok ? null : check.message;

  const unit = detail ? detail.priceCents + chosen.reduce((sum, o) => sum + o.priceDeltaCents, 0) : 0;

  function toggle(groupId: string, optionId: string, maxSelect: number) {
    setSelected((current) => {
      const list = current[groupId] ?? [];
      if (list.includes(optionId)) {
        return { ...current, [groupId]: list.filter((id) => id !== optionId) };
      }
      // Escolha única troca em vez de acumular — o que se espera de "Tamanho".
      if (maxSelect === 1) return { ...current, [groupId]: [optionId] };
      if (list.length >= maxSelect) return current;
      return { ...current, [groupId]: [...list, optionId] };
    });
  }

  function confirm() {
    if (!detail || problem) return;
    add({
      product: { ...detail, categoryId: null, thumbUrl: null } as never,
      branchId: menu.branch.id,
      organizationSlug,
      branchSlug,
      quantity,
      selectedOptions: chosen,
      notes: notes.trim() || undefined,
    });
    onAdded();
  }

  return (
    <Sheet
      open={product !== null}
      onClose={onClose}
      title={product?.name ?? ''}
      // Rodapé fixo: o botão de adicionar não pode sumir ao rolar uma lista
      // longa de adicionais.
      footer={
        detail ? (
          <div className="sheetfoot">
            <div className="stepper" role="group" aria-label="Quantidade">
              <button
                type="button"
                aria-label="Diminuir"
                disabled={quantity <= 1}
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                −
              </button>
              <span aria-live="polite" className="tnum">
                {quantity}
              </span>
              <button type="button" aria-label="Aumentar" onClick={() => setQuantity((q) => q + 1)}>
                +
              </button>
            </div>

            <button
              type="button"
              className="ui-btn ui-btn--primary sheetfoot__add"
              disabled={problem !== null || !detail.availability.isPurchasable}
              onClick={confirm}
            >
              {problem ? (
                problem
              ) : (
                <>
                  Adicionar · <Price cents={unit * quantity} />
                </>
              )}
            </button>
          </div>
        ) : undefined
      }
    >
      {error ? <div className="ui-notice ui-notice--danger">{error}</div> : null}

      {!detail && !error ? (
        <div className="sheetbody">
          <Skeleton height={140} radius={16} />
          <Skeleton width="60%" height={20} />
          <Skeleton width="90%" height={14} />
        </div>
      ) : null}

      {detail ? (
        <div className="sheetbody">
          {detail.images[0] ? (
            <img
              className="sheetbody__img"
              src={detail.images[0].url}
              alt={detail.images[0].altText ?? ''}
            />
          ) : null}

          {detail.description ? <p className="sheetbody__desc">{detail.description}</p> : null}

          {detail.modifierGroups.map((group) => {
            const list = selected[group.id] ?? [];
            return (
              <fieldset key={group.id} className="opt">
                <legend className="opt__legend">
                  <span>{group.name}</span>
                  <span className={group.isRequired ? 'opt__tag opt__tag--req' : 'opt__tag'}>
                    {group.isRequired
                      ? 'obrigatório'
                      : group.maxSelect > 1
                        ? `até ${group.maxSelect}`
                        : 'opcional'}
                  </span>
                </legend>

                {group.options.map((option) => {
                  const on = list.includes(option.id);
                  // Trava só o que ainda NÃO foi escolhido: desmarcar precisa
                  // continuar possível, senão o cliente fica preso.
                  const full = !on && group.maxSelect > 1 && list.length >= group.maxSelect;

                  return (
                    <label key={option.id} className={`opt__row ${full ? 'opt__row--off' : ''}`}>
                      <input
                        type={group.maxSelect === 1 ? 'radio' : 'checkbox'}
                        name={group.id}
                        checked={on}
                        disabled={full}
                        onChange={() => toggle(group.id, option.id, group.maxSelect)}
                      />
                      <span className="opt__name">{option.name}</span>
                      {option.priceDeltaCents !== 0 ? (
                        <span className="opt__delta">
                          {option.priceDeltaCents > 0 ? '+ ' : '− '}
                          <Price cents={Math.abs(option.priceDeltaCents)} />
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </fieldset>
            );
          })}

          {detail.allowsCustomerNotes ? (
            <div className="ui-field">
              <label htmlFor="obs">Alguma observação?</label>
              <input
                id="obs"
                className="ui-input"
                value={notes}
                maxLength={200}
                placeholder="Ex.: sem cebola"
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          ) : null}
        </div>
      ) : null}

    </Sheet>
  );
}
