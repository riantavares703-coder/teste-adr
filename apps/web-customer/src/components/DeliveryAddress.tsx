import { useEffect, useRef, useState } from 'react';
import type { AddressInput, DeliveryInfo, DeliveryQuote } from '@plataforma/client';
import {
  Field,
  MapPicker,
  Notice,
  Price,
  reverseGeocode,
  searchAddress,
  type GeoAddress,
  type LatLng,
} from '@plataforma/ui-web';
import { useStore } from '../store-context';

export interface DeliveryChoice {
  address: AddressInput;
  quote: DeliveryQuote;
}

interface Form {
  postalCode: string;
  street: string;
  streetNumber: string;
  complement: string;
  district: string;
  city: string;
  stateCode: string;
}

const EMPTY: Form = { postalCode: '', street: '', streetNumber: '', complement: '', district: '', city: '', stateCode: '' };

const maskCep = (v: string) => {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};

/**
 * Endereço de entrega: busca por texto, mapa com pino arrastável e campos
 * editáveis. A taxa e a área vêm do servidor (cotação), nunca do navegador.
 * Emite `null` até o endereço estar completo E dentro da área de entrega.
 */
export function DeliveryAddress({ onChange }: { onChange: (choice: DeliveryChoice | null) => void }) {
  const { api, menu } = useStore();
  const [info, setInfo] = useState<DeliveryInfo | null>(null);
  const [point, setPoint] = useState<LatLng | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoAddress[]>([]);
  const [searching, setSearching] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    api.getDeliveryInfo(menu.branch.id).then(setInfo).catch(() => setInfo(null));
  }, [api, menu.branch.id]);

  const store: LatLng | null =
    info?.latitude != null && info.longitude != null
      ? { latitude: info.latitude, longitude: info.longitude }
      : null;

  function fill(a: GeoAddress, keepNumber: boolean) {
    setForm((f) => ({
      postalCode: a.postalCode ? maskCep(a.postalCode) : f.postalCode,
      street: a.street || f.street,
      streetNumber: keepNumber && f.streetNumber ? f.streetNumber : a.streetNumber || f.streetNumber,
      complement: f.complement,
      district: a.district || f.district,
      city: a.city || f.city,
      stateCode: a.stateCode || f.stateCode,
    }));
  }

  async function runSearch() {
    setSearching(true);
    setGeoError(null);
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      const found = await searchAddress(query, abort.current.signal);
      setResults(found);
      if (found.length === 0) setGeoError('Não achamos esse endereço. Toque no mapa para marcar o local.');
    } catch {
      setGeoError('Busca indisponível agora. Toque no mapa ou preencha os campos.');
    } finally {
      setSearching(false);
    }
  }

  function pick(a: GeoAddress) {
    setResults([]);
    setQuery(a.label);
    setPoint({ latitude: a.latitude, longitude: a.longitude });
    fill(a, false);
  }

  async function onMapPoint(p: LatLng) {
    setPoint(p);
    setGeoError(null);
    try {
      const a = await reverseGeocode(p.latitude, p.longitude);
      if (a) fill(a, true);
    } catch {
      setGeoError('Marcamos o ponto, mas não conseguimos ler o endereço. Preencha os campos.');
    }
  }

  const cepDigits = form.postalCode.replace(/\D/g, '');
  const complete =
    cepDigits.length === 8 &&
    form.street.trim().length >= 2 &&
    form.streetNumber.trim().length >= 1 &&
    form.district.trim().length >= 2 &&
    form.city.trim().length >= 2 &&
    form.stateCode.trim().length === 2;

  useEffect(() => {
    setQuote(null);
    if (cepDigits.length !== 8) return;
    let cancelled = false;
    setQuoting(true);
    const t = setTimeout(() => {
      api
        .quoteDelivery({
          branchId: menu.branch.id,
          postalCode: cepDigits,
          ...(point ? point : {}),
        })
        .then((q) => !cancelled && setQuote(q))
        .catch(() => !cancelled && setQuote(null))
        .finally(() => !cancelled && setQuoting(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, menu.branch.id, cepDigits, point?.latitude, point?.longitude]);

  useEffect(() => {
    if (!complete || !quote?.deliverable) {
      onChange(null);
      return;
    }
    onChange({
      quote,
      address: {
        postalCode: cepDigits,
        street: form.street.trim(),
        streetNumber: form.streetNumber.trim(),
        ...(form.complement.trim() ? { complement: form.complement.trim() } : {}),
        district: form.district.trim(),
        city: form.city.trim(),
        stateCode: form.stateCode.trim().toUpperCase(),
        ...(point ? point : {}),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complete, quote, form, point?.latitude, point?.longitude]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="ui-card">
      <h3>Endereço de entrega</h3>

      <Field
        label="Buscar endereço"
        value={query}
        placeholder="Rua, número e cidade"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void runSearch();
          }
        }}
      />
      <button type="button" className="ui-btn ui-btn--ghost" disabled={searching} onClick={() => void runSearch()}>
        {searching ? 'Buscando…' : 'Buscar'}
      </button>
      {results.length > 0 ? (
        <ul className="addr-results">
          {results.map((r, i) => (
            <li key={`${r.latitude},${r.longitude},${i}`}>
              <button type="button" onClick={() => pick(r)}>
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {geoError ? <small role="alert">{geoError}</small> : null}

      <p className="form__hint">Toque no mapa ou arraste o pino para marcar o local exato.</p>
      <MapPicker
        value={point}
        onChange={(p) => void onMapPoint(p)}
        store={store}
        radiusMeters={info?.active ? info.radiusMeters : null}
        label="Mapa de entrega. Toque para marcar o local."
      />

      <div className="addr-grid">
        <Field label="CEP" inputMode="numeric" value={form.postalCode} placeholder="00000-000"
          onChange={(e) => setForm((f) => ({ ...f, postalCode: maskCep(e.target.value) }))} />
        <Field label="Número" value={form.streetNumber} onChange={set('streetNumber')} />
        <div className="addr-wide">
          <Field label="Rua" value={form.street} onChange={set('street')} />
        </div>
        <Field label="Complemento" value={form.complement} placeholder="Apto, bloco…" onChange={set('complement')} />
        <Field label="Bairro" value={form.district} onChange={set('district')} />
        <Field label="Cidade" value={form.city} onChange={set('city')} />
        <Field label="UF" value={form.stateCode} maxLength={2} onChange={set('stateCode')} />
      </div>

      {quoting ? <small>Calculando entrega…</small> : null}
      {!quoting && quote?.deliverable ? (
        <Notice tone="success" title="Entregamos nesse endereço">
          Taxa de entrega <Price cents={quote.feeCents ?? 0} />
          {quote.etaMinutes ? ` · cerca de ${quote.etaMinutes} min` : ''}
        </Notice>
      ) : null}
      {!quoting && quote && !quote.deliverable ? (
        <Notice tone="danger" title="Fora da área de entrega">
          Esse endereço está fora da área atendida pela loja. Escolha “Retirar” ou marque outro local.
        </Notice>
      ) : null}
      {!quoting && !quote && cepDigits.length === 8 ? (
        <small>Não foi possível calcular a entrega agora. Tente de novo.</small>
      ) : null}
    </div>
  );
}
