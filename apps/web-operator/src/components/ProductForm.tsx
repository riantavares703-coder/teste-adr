import { useEffect, useState, type FormEvent } from 'react';
import type { MenuProduct, ModifierGroupAdmin } from '@plataforma/client';
import { Button, Field, Notice, friendlyMessage } from '@plataforma/ui-web';
import { useSession } from '../session';
import { ModifierGroupEditor } from './ModifierGroupEditor';

type Product = MenuProduct & { isActive: boolean };

/**
 * Cadastro do produto.
 *
 * O preço é digitado em reais e convertido para CENTAVOS antes de sair daqui.
 * Todo o resto do sistema fala centavos inteiros (ADR-0010); a conversão mora
 * na fronteira, num lugar só.
 */
export function ProductForm({
  product,
  categories,
  onDone,
  onCancel,
}: {
  product: Product | null;
  categories: Array<{ id: string; name: string }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { api, branch } = useSession();

  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [price, setPrice] = useState(product ? centsToInput(product.priceCents) : '');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [isFeatured, setIsFeatured] = useState(product?.isFeatured ?? false);
  const [allowsNotes, setAllowsNotes] = useState(product?.allowsCustomerNotes ?? true);

  const [groups, setGroups] = useState<ModifierGroupAdmin[]>([]);
  const [linkedIds, setLinkedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.listModifierGroups(branch.id);
        if (cancelled) return;
        setGroups(loaded);

        // Quais grupos ESTE produto já usa: vem do detalhe público, que é onde
        // o vínculo é lido hoje.
        if (product) {
          const detail = await api.getProduct(product.id);
          if (!cancelled) setLinkedIds(detail.modifierGroups.map((g) => g.id));
        }
      } catch {
        // Sem opções carregadas o formulário ainda salva nome e preço.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, branch.id, product]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const priceCents = inputToCents(price);
    if (priceCents === null) {
      setError('Informe um preço válido, como 29,90');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        priceCents,
        categoryId: categoryId || null,
        isFeatured,
        allowsCustomerNotes: allowsNotes,
      };

      const saved = product
        ? await api.updateProduct(branch.id, product.id, body)
        : await api.createProduct(branch.id, body);

      const productId = product?.id ?? (saved as { id: string }).id;
      await api.setProductModifierGroups(branch.id, productId, linkedIds);

      onDone();
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <div className="ui-section-header">
        <h2>{product ? `Editar ${product.name}` : 'Novo produto'}</h2>
        <Button variant="ghost" onClick={onCancel}>
          Voltar
        </Button>
      </div>

      <form onSubmit={submit}>
        <div className="ui-card">
          <Field
            label="Nome"
            value={name}
            required
            autoFocus
            placeholder="Ex.: X-Bacon"
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            label="Descrição"
            value={description}
            placeholder="Ex.: Pão brioche, hambúrguer 180g, bacon"
            onChange={(e) => setDescription(e.target.value)}
          />
          <Field
            label="Preço (R$)"
            value={price}
            required
            inputMode="decimal"
            placeholder="29,90"
            onChange={(e) => setPrice(e.target.value)}
          />

          <div className="ui-field">
            <label htmlFor="cat">Seção</label>
            <select
              id="cat"
              className="ui-input"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Sem seção</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <label className="form__check">
            <input
              type="checkbox"
              checked={isFeatured}
              onChange={(e) => setIsFeatured(e.target.checked)}
            />
            <span>Mostrar em destaque no cardápio</span>
          </label>

          <label className="form__check">
            <input
              type="checkbox"
              checked={allowsNotes}
              onChange={(e) => setAllowsNotes(e.target.checked)}
            />
            <span>Cliente pode escrever observação (ex.: sem cebola)</span>
          </label>
        </div>

        <ModifierGroupEditor
          groups={groups}
          linkedIds={linkedIds}
          onToggleLink={(id) =>
            setLinkedIds((current) =>
              current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
            )
          }
          onChanged={async () => setGroups(await api.listModifierGroups(branch.id))}
        />

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className="form__footer">
          <Button type="submit" loading={submitting}>
            {product ? 'Salvar' : 'Criar produto'}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * "29,90" ou "29.90" → 2990.
 *
 * Multiplicar por 100 em ponto flutuante erra (29.90 * 100 = 2989.9999...), e
 * erro de arredondamento em dinheiro é defeito financeiro. Por isso a conversão
 * é feita sobre os DÍGITOS, sem aritmética de fração.
 */
export function inputToCents(value: string): number | null {
  const cleaned = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [reais, centavos = ''] = cleaned.split('.');
  return Number(reais) * 100 + Number(centavos.padEnd(2, '0'));
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}
