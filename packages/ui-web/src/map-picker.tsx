import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface LatLng {
  readonly latitude: number;
  readonly longitude: number;
}

interface MapPickerProps {
  /** Ponto escolhido (pino arrastável). */
  value: LatLng | null;
  onChange: (point: LatLng) => void;
  /** Ponto fixo da loja, desenhado à parte (mapa do cliente). */
  store?: LatLng | null;
  /** Raio de entrega em metros, desenhado em volta de `store` (ou de `value` se não houver loja). */
  radiusMeters?: number | null;
  height?: number;
  label?: string;
}

const FALLBACK_CENTER: LatLng = { latitude: -14.235, longitude: -51.925 }; // centro do Brasil

const pin = (color: string) =>
  L.divIcon({
    className: 'map-pin',
    html: `<span style="background:${color}"></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });

/**
 * Mapa estilo Google Maps (tiles do OpenStreetMap). Toque no mapa ou arraste o
 * pino para escolher o ponto. Pinos são divIcon — sem imagens para o bundler
 * resolver — e o mapa é desmontado junto com o componente.
 */
export function MapPicker({ value, onChange, store, radiusMeters, height = 280, label }: MapPickerProps) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const storeMarker = useRef<L.Marker | null>(null);
  const circle = useRef<L.Circle | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current || map.current) return;
    const start = value ?? store ?? FALLBACK_CENTER;
    const m = L.map(host.current, { zoomControl: true, attributionControl: true }).setView(
      [start.latitude, start.longitude],
      value || store ? 15 : 4,
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) =>
      onChangeRef.current({ latitude: e.latlng.lat, longitude: e.latlng.lng }),
    );
    map.current = m;
    // O contêiner pode nascer com tamanho 0 (dentro de card/sheet): recalcula após o layout.
    const t = setTimeout(() => m.invalidateSize(), 150);
    return () => {
      clearTimeout(t);
      m.remove();
      map.current = null;
      marker.current = null;
      storeMarker.current = null;
      circle.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A loja costuma chegar DEPOIS do mapa montado (veio de uma requisição): recentra uma vez.
  const centeredOnStore = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m || !store || centeredOnStore.current || value) return;
    centeredOnStore.current = true;
    m.setView([store.latitude, store.longitude], 15);
  }, [store?.latitude, store?.longitude]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!value) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    const at: L.LatLngExpression = [value.latitude, value.longitude];
    if (!marker.current) {
      marker.current = L.marker(at, { draggable: true, icon: pin('#e11d48'), keyboard: false }).addTo(m);
      marker.current.on('dragend', () => {
        const p = marker.current!.getLatLng();
        onChangeRef.current({ latitude: p.lat, longitude: p.lng });
      });
    } else {
      marker.current.setLatLng(at);
    }
    if (!m.getBounds().contains(at)) m.panTo(at);
  }, [value?.latitude, value?.longitude]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!store) {
      storeMarker.current?.remove();
      storeMarker.current = null;
    } else if (!storeMarker.current) {
      storeMarker.current = L.marker([store.latitude, store.longitude], {
        icon: pin('#0f172a'),
        interactive: false,
        keyboard: false,
      }).addTo(m);
    } else {
      storeMarker.current.setLatLng([store.latitude, store.longitude]);
    }

    const around = store ?? value;
    if (!radiusMeters || !around) {
      circle.current?.remove();
      circle.current = null;
      return;
    }
    const at: L.LatLngExpression = [around.latitude, around.longitude];
    if (!circle.current) {
      circle.current = L.circle(at, {
        radius: radiusMeters,
        color: '#e11d48',
        weight: 2,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(m);
    } else {
      circle.current.setLatLng(at);
      circle.current.setRadius(radiusMeters);
    }
  }, [store?.latitude, store?.longitude, radiusMeters, value?.latitude, value?.longitude]);

  return (
    <div
      ref={host}
      className="map-picker"
      style={{ height }}
      role="application"
      aria-label={label ?? 'Mapa. Toque para escolher o ponto.'}
    />
  );
}
