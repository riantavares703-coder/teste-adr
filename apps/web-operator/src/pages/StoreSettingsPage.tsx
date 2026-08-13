import { useCallback, useEffect, useState } from 'react';
import type { PixSettingsView, StoreSettings } from '@plataforma/client';
import {
  WEEKDAYS,
  describeOpenState,
  type BusinessHour,
  type PaymentMethod,
} from '@plataforma/domain';
import { AsyncBoundary, Badge, Button, Notice, friendlyMessage } from '@plataforma/ui-web';
import { useSession } from '../session';
import { centsToInput, inputToCents } from '../components/ProductForm';

const METHOD_LABEL: Record<string, string> = {
  PIX: 'Pix',
  CASH_ON_SITE: 'Dinheiro',
  CREDIT_ON_SITE: 'Crédito',
  DEBIT_ON_SITE: 'Débito',
};

const ALL_METHODS: PaymentMethod[] = ['PIX', 'CASH_ON_SITE', 'CREDIT_ON_SITE', 'DEBIT_ON_SITE'];

const PIX_KEY_TYPE_LABEL: Record<string, string> = {
  CPF: 'CPF',
  CNPJ: 'CNPJ',
  EMAIL: 'E-mail',
  PHONE: 'Telefone',
  RANDOM: 'Chave aleatória',
};

/**
 * HORÁRIO E CONFIGURAÇÕES DA LOJA.
 *
 * O horário é editado como um conjunto e gravado de uma vez — a regra que
 * importa (duas faixas não podem se sobrepor) é do conjunto, não da linha.
 *
 * O tempo de preparo daqui não é enfeite: é ele que gera a previsão de conclusão
 * do pedido, que vira a barra de progresso na tela do cliente.
 */
export function StoreSettingsPage() {
  const { api, branch, can } = useSession();

  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [hours, setHours] = useState<BusinessHour[]>([]);
  const [prep, setPrep] = useState('20');
  const [minOrder, setMinOrder] = useState('0');
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [pix, setPix] = useState<PixSettingsView | null>(null);
  const [pixKeyType, setPixKeyType] = useState('RANDOM');
  const [pixKey, setPixKey] = useState('');
  const [pixMerchantName, setPixMerchantName] = useState('');
  const [pixMerchantCity, setPixMerchantCity] = useState('');
  const [pixError, setPixError] = useState<string | null>(null);
  const [pixSaving, setPixSaving] = useState(false);

  const editable = can('settings:update');
  const pixReadable = can('pix_settings:read');
  const pixEditable = can('pix_settings:update');

  const load = useCallback(async () => {
    try {
      const [loaded, pixLoaded] = await Promise.all([
        api.getSettings(branch.id),
        pixReadable ? api.getPixSettings(branch.id) : Promise.resolve(null),
      ]);
      setSettings(loaded);
      setHours(loaded.hours);
      setPrep(String(loaded.preparationTimeMinutes));
      setMinOrder(centsToInput(loaded.minOrderCents));
      setMethods(loaded.enabledPaymentMethods);
      setPix(pixLoaded);
      if (pixLoaded?.keyType) setPixKeyType(pixLoaded.keyType);
      if (pixLoaded?.merchantName) setPixMerchantName(pixLoaded.merchantName);
      if (pixLoaded?.merchantCity) setPixMerchantCity(pixLoaded.merchantCity);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, branch.id, pixReadable]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  function announce(message: string) {
    setSaved(message);
    setTimeout(() => setSaved(null), 3000);
  }

  async function saveSettings() {
    const minutes = Number(prep);
    const minCents = inputToCents(minOrder);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 480) {
      setSaveError('O tempo de preparo deve ser entre 0 e 480 minutos');
      return;
    }
    if (minCents === null) {
      setSaveError('Informe um pedido mínimo válido, como 25,00');
      return;
    }
    if (methods.length === 0) {
      setSaveError('Aceite ao menos uma forma de pagamento');
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      setSettings(
        await api.updateSettings(branch.id, {
          preparationTimeMinutes: minutes,
          minOrderCents: minCents,
          enabledPaymentMethods: methods,
        }),
      );
      announce('Configurações salvas');
    } catch (e) {
      setSaveError(friendlyMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveHours() {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.replaceHours(branch.id, hours);
      setSettings(updated);
      setHours(updated.hours);
      announce('Horário salvo');
    } catch (e) {
      setSaveError(friendlyMessage(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * A chave digitada NUNCA é reaproveitada de volta no formulário: o servidor
   * só devolve a máscara. Trocar a chave é sempre digitar de novo, o que evita
   * mostrar em tela algo que nem o próprio operador logado deveria reler.
   */
  async function savePix() {
    if (!pixKey.trim() || !pixMerchantName.trim() || !pixMerchantCity.trim()) {
      setPixError('Preencha a chave, o nome e a cidade do recebedor');
      return;
    }
    setPixSaving(true);
    setPixError(null);
    try {
      await api.setPixSettings(branch.id, {
        keyType: pixKeyType,
        key: pixKey.trim(),
        merchantName: pixMerchantName.trim(),
        merchantCity: pixMerchantCity.trim(),
      });
      setPix(await api.getPixSettings(branch.id));
      setPixKey('');
      announce('Chave Pix salva');
    } catch (e) {
      setPixError(friendlyMessage(e));
    } finally {
      setPixSaving(false);
    }
  }

  function addRange(weekday: number) {
    setHours((current) => [
      ...current,
      { weekday: weekday as BusinessHour['weekday'], opensAt: '18:00', closesAt: '23:00' },
    ]);
  }

  function updateRange(index: number, patch: Partial<BusinessHour>) {
    setHours((current) => current.map((hour, i) => (i === index ? { ...hour, ...patch } : hour)));
  }

  return (
    <section>
      <div className="ui-section-header">
        <h2>Horário e configurações</h2>
        {settings ? (
          <Badge tone={settings.open.isOpen ? 'success' : 'warning'}>
            {describeOpenState(settings.open)}
          </Badge>
        ) : null}
      </div>

      <AsyncBoundary loading={loading} error={error} onRetry={() => void load()}>
        {settings ? (
          <>
            {saved ? (
              // aria-live: quem usa leitor de tela precisa saber que salvou sem
              // ter de procurar a mensagem na página.
              <div className="ui-notice ui-notice--success" role="status" aria-live="polite">
                {saved}
              </div>
            ) : null}
            {saveError ? <Notice tone="danger">{saveError}</Notice> : null}

            <div className="ui-card">
              <h3>Horário de funcionamento</h3>
              <p className="form__hint">
                Sem nenhum horário cadastrado, a loja aceita pedidos a qualquer hora.
                Para fechar de madrugada, use uma faixa que atravessa a meia-noite
                (ex.: 18:00 às 02:00).
              </p>

              {WEEKDAYS.map((label, weekday) => {
                const ranges = hours
                  .map((hour, index) => ({ hour, index }))
                  .filter(({ hour }) => hour.weekday === weekday);

                return (
                  <div key={label} className="hours__day">
                    <span className="hours__label">{label}</span>

                    <div className="hours__ranges">
                      {ranges.length === 0 ? <span className="hours__closed">Fechado</span> : null}

                      {ranges.map(({ hour, index }) => (
                        <div key={index} className="hours__range">
                          <input
                            type="time"
                            className="ui-input"
                            value={hour.opensAt}
                            disabled={!editable}
                            aria-label={`${label}: abre às`}
                            onChange={(e) => updateRange(index, { opensAt: e.target.value })}
                          />
                          <span aria-hidden="true">às</span>
                          <input
                            type="time"
                            className="ui-input"
                            value={hour.closesAt}
                            disabled={!editable}
                            aria-label={`${label}: fecha às`}
                            onChange={(e) => updateRange(index, { closesAt: e.target.value })}
                          />
                          {editable ? (
                            <button
                              type="button"
                              className="catbar__remove"
                              aria-label={`Remover faixa de ${label}`}
                              onClick={() => setHours((c) => c.filter((_, i) => i !== index))}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      ))}

                      {editable ? (
                        <button
                          type="button"
                          className="ui-btn ui-btn--ghost"
                          onClick={() => addRange(weekday)}
                        >
                          + faixa
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}

              {editable ? (
                <div className="form__footer">
                  <Button loading={saving} onClick={() => void saveHours()}>
                    Salvar horário
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="ui-card">
              <h3>Pedidos</h3>

              <div className="ui-field">
                <label htmlFor="prep">Tempo de preparo (minutos)</label>
                <input
                  id="prep"
                  className="ui-input"
                  type="number"
                  min={0}
                  max={480}
                  value={prep}
                  disabled={!editable}
                  onChange={(e) => setPrep(e.target.value)}
                />
                <small className="ui-field__hint">
                  É a previsão que o cliente vê na barra de acompanhamento do pedido.
                </small>
              </div>

              <div className="ui-field">
                <label htmlFor="min">Pedido mínimo (R$)</label>
                <input
                  id="min"
                  className="ui-input"
                  inputMode="decimal"
                  value={minOrder}
                  disabled={!editable}
                  onChange={(e) => setMinOrder(e.target.value)}
                />
              </div>

              <fieldset className="form__fieldset">
                <legend>Formas de pagamento aceitas</legend>
                {ALL_METHODS.map((method) => (
                  <label key={method} className="form__check">
                    <input
                      type="checkbox"
                      checked={methods.includes(method)}
                      disabled={!editable}
                      onChange={(e) =>
                        setMethods((current) =>
                          e.target.checked
                            ? [...current, method]
                            : current.filter((m) => m !== method),
                        )
                      }
                    />
                    <span>{METHOD_LABEL[method]}</span>
                  </label>
                ))}
              </fieldset>

              {methods.includes('PIX') && pix && !pix.configured ? (
                <Notice tone="warning" title="Pix aceito, mas sem chave cadastrada">
                  Um cliente que escolher Pix vai receber erro ao fechar o pedido. Cadastre a
                  chave logo abaixo, ou desmarque Pix até configurar.
                </Notice>
              ) : null}

              {editable ? (
                <div className="form__footer">
                  <Button loading={saving} onClick={() => void saveSettings()}>
                    Salvar configurações
                  </Button>
                </div>
              ) : null}
            </div>

            {pixReadable ? (
              <div className="ui-card">
                <h3>Chave Pix</h3>
                <p className="form__hint">
                  Gerada no seu próprio celular ao pagar: sem taxa, sem intermediário. A loja
                  precisa confirmar o recebimento manualmente — nenhum código Pix estático avisa
                  sozinho que o dinheiro caiu.
                </p>

                {pix?.configured ? (
                  <p>
                    Chave atual: <strong>{PIX_KEY_TYPE_LABEL[pix.keyType ?? ''] ?? pix.keyType}</strong>{' '}
                    terminada em <strong>{pix.keyMasked}</strong>
                  </p>
                ) : (
                  <p className="form__hint">Nenhuma chave cadastrada ainda.</p>
                )}

                {pixEditable ? (
                  <>
                    <div className="ui-field">
                      <label htmlFor="pixTipo">Tipo de chave</label>
                      <select
                        id="pixTipo"
                        className="ui-input"
                        value={pixKeyType}
                        onChange={(e) => setPixKeyType(e.target.value)}
                      >
                        {Object.entries(PIX_KEY_TYPE_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="ui-field">
                      <label htmlFor="pixChave">
                        {pix?.configured ? 'Nova chave (substitui a atual)' : 'Chave Pix'}
                      </label>
                      <input
                        id="pixChave"
                        className="ui-input"
                        value={pixKey}
                        placeholder="CPF, e-mail, telefone ou chave aleatória"
                        onChange={(e) => setPixKey(e.target.value)}
                      />
                    </div>

                    <div className="ui-field">
                      <label htmlFor="pixNome">Nome do recebedor</label>
                      <input
                        id="pixNome"
                        className="ui-input"
                        value={pixMerchantName}
                        maxLength={25}
                        placeholder="Como aparece no app do banco de quem paga"
                        onChange={(e) => setPixMerchantName(e.target.value)}
                      />
                    </div>

                    <div className="ui-field">
                      <label htmlFor="pixCidade">Cidade do recebedor</label>
                      <input
                        id="pixCidade"
                        className="ui-input"
                        value={pixMerchantCity}
                        maxLength={15}
                        onChange={(e) => setPixMerchantCity(e.target.value)}
                      />
                    </div>

                    {pixError ? <Notice tone="danger">{pixError}</Notice> : null}

                    <div className="form__footer">
                      <Button loading={pixSaving} onClick={() => void savePix()}>
                        {pix?.configured ? 'Substituir chave' : 'Salvar chave'}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </AsyncBoundary>
    </section>
  );
}
