import { useEffect, useState } from 'react';
import {
  Button,
  Field,
  MapPicker,
  Notice,
  friendlyMessage,
  searchAddress,
  type GeoAddress,
  type LatLng,
} from '@plataforma/ui-web';
import { useSession } from '../session';
import { centsToInput, inputToCents } from './ProductForm';

/**
 * Área de entrega da unidade: ponto da loja no mapa + raio + taxa.
 * O cliente só enxerga o resultado (cotação calculada no servidor).
 */
export function DeliveryZoneCard({ branchId, editable }: { branchId: string; editable: boolean }) {
  const { api } = useSession();
  const [point, setPoint] = useState<LatLng | null>(null);
  const [radiusKm, setRadiusKm] = useState('3');
  const [fee, setFee] = useState('5,00');
  const [minOrder, setMinOrder] = useState('0,00');
  const [eta, setEta] = useState('40');
  const [active, setActive] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoAddress[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDeliveryConfig(branchId)
      .then((c) => {
        if (c.latitude != null && c.longitude != null) setPoint({ latitude: c.latitude, longitude: c.longitude });
        setRadiusKm(String(c.radiusMeters / 1000).replace('.', ','));
        setFee(centsToInput(c.feeCents));
        setMinOrder(centsToInput(c.minOrderCents));
        setEta(String(c.etaMinutes));
        setActive(c.configured ? c.isActive : true);
        setConfigured(c.configured);
      })
      .catch((e) => setError(friendlyMessage(e)));
  }, [api, branchId]);

  async function search() {
    setSearchError(null);
    try {
      const found = await searchAddress(query);
      setResults(found);
      if (found.length === 0) setSearchError('Endereço não encontrado. Toque no mapa para marcar a loja.');
    } catch {
      setSearchError('Busca indisponível agora. Toque no mapa para marcar a loja.');
    }
  }

  async function save() {
    const km = Number(radiusKm.replace(',', '.'));
    const feeCents = inputToCents(fee);
    const minCents = inputToCents(minOrder);
    const etaMin = Number(eta);
    if (!point) return setError('Marque no mapa onde fica a loja.');
    if (!Number.isFinite(km) || km < 0.2 || km > 50) return setError('Raio entre 0,2 e 50 km.');
    if (feeCents === null || minCents === null) return setError('Confira a taxa e o pedido mínimo.');
    if (!Number.isInteger(etaMin) || etaMin < 5 || etaMin > 240) return setError('Prazo entre 5 e 240 minutos.');

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.setDeliveryConfig(branchId, {
        latitude: point.latitude,
        longitude: point.longitude,
        radiusMeters: Math.round(km * 1000),
        feeCents,
        minOrderCents: minCents,
        etaMinutes: etaMin,
        isActive: active,
      });
      setConfigured(true);
      setSaved(true);
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const km = Number(radiusKm.replace(',', '.'));

  return (
    <div className="ui-card">
      <h3>Área de entrega</h3>
      <p className="form__hint">
        Marque onde fica a loja e defina até quantos km você entrega. Clientes fora do círculo não
        conseguem pedir entrega.
      </p>
      {!configured ? (
        <Notice tone="warning" title="Entrega ainda não configurada">
          Enquanto a área não for salva, nenhum cliente consegue pedir entrega.
        </Notice>
      ) : null}

      {editable ? (
        <>
          <Field
            label="Buscar o endereço da loja"
            value={query}
            placeholder="Rua, número e cidade"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void search();
              }
            }}
          />
          <Button onClick={() => void search()}>Buscar</Button>
          {results.length > 0 ? (
            <ul className="addr-results">
              {results.map((r, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => {
                      setPoint({ latitude: r.latitude, longitude: r.longitude });
                      setResults([]);
                      setQuery(r.label);
                    }}
                  >
                    {r.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {searchError ? <small role="alert">{searchError}</small> : null}
        </>
      ) : null}

      <MapPicker
        value={point}
        onChange={editable ? setPoint : () => undefined}
        radiusMeters={Number.isFinite(km) && km > 0 ? km * 1000 : null}
        height={320}
        label="Mapa da área de entrega. Toque para marcar a loja."
      />

      {editable ? (
        <>
          <div className="addr-grid">
            <Field label="Raio de entrega (km)" inputMode="decimal" value={radiusKm} onChange={(e) => setRadiusKm(e.target.value)} />
            <Field label="Taxa de entrega (R$)" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
            <Field label="Pedido mínimo (R$)" inputMode="decimal" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} />
            <Field label="Prazo (minutos)" inputMode="numeric" value={eta} onChange={(e) => setEta(e.target.value)} />
          </div>
          <label className="store__choice">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>Aceitar pedidos de entrega</span>
          </label>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {saved ? <Notice tone="success">Área de entrega salva.</Notice> : null}
          <div className="form__footer">
            <Button loading={saving} onClick={() => void save()}>
              Salvar área de entrega
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
