import { useCallback, useEffect, useState } from 'react';
import type { InventoryRow, MenuProduct } from '@plataforma/client';
import { AsyncBoundary, Badge, Button, EmptyState, Price, friendlyMessage } from '@plataforma/ui-web';
import { useSession } from '../session';
import { ProductForm } from '../components/ProductForm';
import { CategoryBar } from '../components/CategoryBar';

type Product = MenuProduct & { isActive: boolean };

interface Category {
  id: string;
  name: string;
  position: number;
}

/**
 * EDITOR DE CARDÁPIO.
 *
 * Duas coisas diferentes convivem aqui de propósito:
 *
 *  - EDITAR o produto (nome, preço, descrição, opções) — mexe no cardápio;
 *  - TEM / NÃO TEM — mexe na operação do dia.
 *
 * A segunda é a que o balcão usa a toda hora ("acabou o bacon"), então ela é um
 * botão direto na lista, sem abrir formulário. A primeira é rara e mora atrás
 * de "Editar".
 */
export function MenuEditorPage() {
  const { api, branch, can } = useSession();

  const [products, setProducts] = useState<Product[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Product | 'novo' | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  const editable = can('product:update');

  const load = useCallback(async () => {
    try {
      const [loadedProducts, loadedInventory, loadedCategories] = await Promise.all([
        api.listProducts(branch.id),
        api.listInventory(branch.id),
        api.listCategories(branch.id),
      ]);
      setProducts(loadedProducts as Product[]);
      setInventory(loadedInventory);
      setCategories(loadedCategories as Category[]);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, branch.id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function toggleAvailability(product: Product) {
    const row = inventory.find((i) => i.productId === product.id);
    setWorking(product.id);
    setActionError(null);
    try {
      if (row?.isManuallySoldOut) await api.reactivate(branch.id, product.id);
      else await api.markSoldOut(branch.id, product.id);
      await load();
    } catch (e) {
      setActionError(friendlyMessage(e));
    } finally {
      setWorking(null);
    }
  }

  async function remove(product: Product) {
    // Confirmação porque some do cardápio do cliente na hora.
    if (!window.confirm(`Remover "${product.name}" do cardápio?`)) return;
    setWorking(product.id);
    try {
      await api.deleteProduct(branch.id, product.id);
      await load();
    } catch (e) {
      setActionError(friendlyMessage(e));
    } finally {
      setWorking(null);
    }
  }

  const visible = filter ? products.filter((p) => p.categoryId === filter) : products;

  if (editing) {
    return (
      <ProductForm
        product={editing === 'novo' ? null : editing}
        categories={categories}
        onDone={() => {
          setEditing(null);
          void load();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <section>
      <div className="ui-section-header">
        <h2>Cardápio</h2>
        {editable ? <Button onClick={() => setEditing('novo')}>Novo produto</Button> : null}
      </div>

      {actionError ? (
        <div className="ui-notice ui-notice--danger" role="alert">
          {actionError}
        </div>
      ) : null}

      <CategoryBar
        categories={categories}
        selected={filter}
        onSelect={setFilter}
        onChanged={() => void load()}
      />

      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={() => void load()}
        isEmpty={visible.length === 0}
        empty={
          <EmptyState
            icon="🍔"
            title="Nenhum produto ainda"
            description="Crie o primeiro item para o cardápio aparecer para os clientes."
            action={editable ? <Button onClick={() => setEditing('novo')}>Novo produto</Button> : undefined}
          />
        }
      >
        <ul className="editor__list">
          {visible.map((product) => {
            const row = inventory.find((i) => i.productId === product.id);
            const disponivel = row ? !row.isManuallySoldOut : true;

            return (
              <li key={product.id} className="ui-card editor__item">
                <div className="editor__info">
                  <div className="editor__title">
                    <strong>{product.name}</strong>
                    {product.isFeatured ? <Badge tone="info">Destaque</Badge> : null}
                    {!product.isActive ? <Badge tone="neutral">Oculto</Badge> : null}
                  </div>
                  {product.description ? <p>{product.description}</p> : null}
                  <Price cents={product.priceCents} />
                </div>

                <div className="editor__actions">
                  {/* O botão diz o ESTADO, não a ação: no balcão, ler
                      "Tem" e ver verde é mais rápido que interpretar um verbo. */}
                  <button
                    type="button"
                    className={`editor__toggle ${disponivel ? 'editor__toggle--on' : 'editor__toggle--off'}`}
                    disabled={!editable || working === product.id}
                    aria-pressed={disponivel}
                    aria-label={`${product.name}: ${disponivel ? 'disponível' : 'esgotado'}. Tocar para alternar.`}
                    onClick={() => void toggleAvailability(product)}
                  >
                    {disponivel ? '✓ Tem' : '✕ Não tem'}
                  </button>

                  {editable ? (
                    <>
                      <Button variant="secondary" onClick={() => setEditing(product)}>
                        Editar
                      </Button>
                      <Button variant="ghost" onClick={() => void remove(product)}>
                        Remover
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </AsyncBoundary>
    </section>
  );
}
