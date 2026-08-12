import { useState } from 'react';
import type { ModifierGroupAdmin } from '@plataforma/client';
import { Price, friendlyMessage } from '@plataforma/ui-web';
import { useSession } from '../session';
import { centsToInput, inputToCents } from './ProductForm';

/**
 * OPÇÕES QUE O CLIENTE ESCOLHE.
 *
 * Um grupo é a pergunta ("Tamanho"); as opções são as respostas ("Médio",
 * "Bacon +R$ 4,00"). O grupo guarda a regra — obrigatório, mínimo, máximo — e é
 * ela que o servidor aplica ao receber o pedido.
 *
 * Os grupos são da LOJA e ficam disponíveis para qualquer produto: "Adicionais"
 * costuma valer para vários lanches. Aqui o produto apenas MARCA quais usa.
 */
export function ModifierGroupEditor({
  groups,
  linkedIds,
  onToggleLink,
  onChanged,
}: {
  groups: ModifierGroupAdmin[];
  linkedIds: string[];
  onToggleLink: (groupId: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const { api, branch } = useSession();
  const [creating, setCreating] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [required, setRequired] = useState(false);
  const [maxSelect, setMaxSelect] = useState(1);
  const [error, setError] = useState<string | null>(null);

  async function createGroup() {
    if (groupName.trim().length === 0) return;
    try {
      await api.createModifierGroup(branch.id, {
        name: groupName.trim(),
        isRequired: required,
        // Obrigatório implica escolher ao menos uma; sem isso o grupo seria
        // "obrigatório" e ainda assim aceitaria nenhuma escolha.
        minSelect: required ? 1 : 0,
        maxSelect,
      });
      setGroupName('');
      setRequired(false);
      setMaxSelect(1);
      setCreating(false);
      await onChanged();
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }

  return (
    <div className="ui-card">
      <div className="ui-section-header">
        <h3>Opções para o cliente escolher</h3>
        {!creating ? (
          <button type="button" className="ui-btn ui-btn--secondary" onClick={() => setCreating(true)}>
            Novo grupo
          </button>
        ) : null}
      </div>

      <p className="form__hint">
        Marque quais grupos aparecem neste produto. Os grupos ficam guardados na
        loja e podem ser usados em vários produtos.
      </p>

      {creating ? (
        <div className="ui-card form__nested">
          <div className="ui-field">
            <label htmlFor="grupo">Nome do grupo</label>
            <input
              id="grupo"
              className="ui-input"
              autoFocus
              value={groupName}
              placeholder="Ex.: Tamanho, Adicionais"
              onChange={(e) => setGroupName(e.target.value)}
            />
          </div>

          <label className="form__check">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            <span>O cliente é obrigado a escolher</span>
          </label>

          <div className="ui-field">
            <label htmlFor="max">Quantas pode escolher</label>
            <input
              id="max"
              className="ui-input"
              type="number"
              min={1}
              max={20}
              value={maxSelect}
              onChange={(e) => setMaxSelect(Number(e.target.value))}
            />
          </div>

          <div className="form__footer">
            <button type="button" className="ui-btn ui-btn--primary" onClick={() => void createGroup()}>
              Criar grupo
            </button>
            <button type="button" className="ui-btn ui-btn--ghost" onClick={() => setCreating(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <p className="form__hint">Nenhum grupo criado ainda.</p>
      ) : (
        <ul className="groups">
          {groups.map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              linked={linkedIds.includes(group.id)}
              onToggleLink={() => onToggleLink(group.id)}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}

      {error ? (
        <div className="ui-notice ui-notice--danger" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function GroupRow({
  group,
  linked,
  onToggleLink,
  onChanged,
}: {
  group: ModifierGroupAdmin;
  linked: boolean;
  onToggleLink: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { api, branch } = useSession();
  const [optionName, setOptionName] = useState('');
  const [optionPrice, setOptionPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function addOption() {
    if (optionName.trim().length === 0) return;
    // Preço vazio = opção sem custo extra (ex.: "Médio").
    const delta = optionPrice.trim() === '' ? 0 : inputToCents(optionPrice.replace('-', ''));
    if (delta === null) {
      setError('Informe um valor válido, como 4,00');
      return;
    }
    try {
      await api.createModifierOption(branch.id, group.id, {
        name: optionName.trim(),
        priceDeltaCents: optionPrice.trim().startsWith('-') ? -delta : delta,
      });
      setOptionName('');
      setOptionPrice('');
      setError(null);
      await onChanged();
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }

  async function removeOption(optionId: string, name: string) {
    if (!window.confirm(`Remover a opção "${name}"?`)) return;
    try {
      await api.deleteModifierOption(branch.id, optionId);
      await onChanged();
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }

  async function removeGroup() {
    if (!window.confirm(`Remover o grupo "${group.name}" e todas as suas opções?`)) return;
    try {
      await api.deleteModifierGroup(branch.id, group.id);
      await onChanged();
    } catch (e) {
      setError(friendlyMessage(e));
    }
  }

  return (
    <li className="groups__item">
      <div className="groups__head">
        <label className="form__check">
          <input type="checkbox" checked={linked} onChange={onToggleLink} />
          <strong>{group.name}</strong>
        </label>
        <span className="groups__rule">
          {group.isRequired ? 'Obrigatório' : 'Opcional'} · até {group.maxSelect}
        </span>
        <button type="button" className="ui-btn ui-btn--ghost" onClick={() => void removeGroup()}>
          Remover grupo
        </button>
      </div>

      <ul className="groups__options">
        {group.options.map((option) => (
          <li key={option.id}>
            <span>{option.name}</span>
            {option.priceDeltaCents !== 0 ? (
              <span className="groups__delta">
                {option.priceDeltaCents > 0 ? '+' : '−'}
                <Price cents={Math.abs(option.priceDeltaCents)} />
              </span>
            ) : (
              <span className="groups__delta">sem custo</span>
            )}
            <button
              type="button"
              className="catbar__remove"
              aria-label={`Remover opção ${option.name}`}
              onClick={() => void removeOption(option.id, option.name)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="groups__add">
        <input
          className="ui-input"
          value={optionName}
          placeholder="Nome da opção"
          onChange={(e) => setOptionName(e.target.value)}
        />
        <input
          className="ui-input"
          value={optionPrice}
          inputMode="decimal"
          placeholder="+R$ (opcional)"
          onChange={(e) => setOptionPrice(e.target.value)}
        />
        <button type="button" className="ui-btn ui-btn--secondary" onClick={() => void addOption()}>
          Adicionar
        </button>
      </div>

      {error ? (
        <div className="ui-notice ui-notice--danger" role="alert">
          {error}
        </div>
      ) : null}
    </li>
  );
}

export { centsToInput };
