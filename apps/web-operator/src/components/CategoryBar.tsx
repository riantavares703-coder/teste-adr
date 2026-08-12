import { useState } from 'react';
import { friendlyMessage } from '@plataforma/ui-web';
import { useSession } from '../session';

interface Category {
  id: string;
  name: string;
  position: number;
}

/**
 * Filtro por categoria, com a criação embutida.
 *
 * A criação fica aqui, e não numa tela própria, porque categoria quase nunca é
 * criada sozinha — é criada no meio de cadastrar um produto que não tem onde
 * ficar. Uma tela separada obrigaria a sair do fluxo e voltar.
 */
export function CategoryBar({
  categories,
  selected,
  onSelect,
  onChanged,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
}) {
  const { api, branch, can } = useSession();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const editable = can('category:manage');

  async function create() {
    if (name.trim().length === 0) return;
    try {
      await api.createCategory(branch.id, { name: name.trim() });
      setName('');
      setCreating(false);
      onChanged();
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }

  async function remove(category: Category) {
    if (
      !window.confirm(
        `Remover a seção "${category.name}"? Os produtos dela continuam no cardápio, sem seção.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteCategory(branch.id, category.id);
      if (selected === category.id) onSelect(null);
      onChanged();
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }

  return (
    <div className="catbar">
      <div className="catbar__chips" role="group" aria-label="Filtrar por seção">
        <button
          type="button"
          className={`catbar__chip ${selected === null ? 'catbar__chip--on' : ''}`}
          aria-pressed={selected === null}
          onClick={() => onSelect(null)}
        >
          Todos
        </button>

        {categories.map((category) => (
          <span key={category.id} className="catbar__group">
            <button
              type="button"
              className={`catbar__chip ${selected === category.id ? 'catbar__chip--on' : ''}`}
              aria-pressed={selected === category.id}
              onClick={() => onSelect(category.id)}
            >
              {category.name}
            </button>
            {editable ? (
              <button
                type="button"
                className="catbar__remove"
                aria-label={`Remover seção ${category.name}`}
                onClick={() => void remove(category)}
              >
                ×
              </button>
            ) : null}
          </span>
        ))}

        {editable && !creating ? (
          <button type="button" className="catbar__chip" onClick={() => setCreating(true)}>
            + Nova seção
          </button>
        ) : null}
      </div>

      {creating ? (
        <div className="catbar__new">
          <input
            className="ui-input"
            autoFocus
            value={name}
            placeholder="Nome da seção (ex.: Bebidas)"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') setCreating(false);
            }}
          />
          <button type="button" className="ui-btn ui-btn--primary" onClick={() => void create()}>
            Criar
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--ghost"
            onClick={() => {
              setCreating(false);
              setName('');
            }}
          >
            Cancelar
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="ui-notice ui-notice--danger" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
