/**
 * Geocodificação via Nominatim (OpenStreetMap), chamada direto do navegador do
 * cliente — o servidor da loja não precisa de internet para isso. Uso leve
 * (uma busca por digitação confirmada), dentro da política pública do serviço.
 */

export interface GeoAddress {
  readonly latitude: number;
  readonly longitude: number;
  readonly label: string;
  readonly postalCode: string;
  readonly street: string;
  readonly streetNumber: string;
  readonly district: string;
  readonly city: string;
  readonly stateCode: string;
}

interface NominatimItem {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string | undefined>;
}

const BASE = 'https://nominatim.openstreetmap.org';

function toGeoAddress(item: NominatimItem): GeoAddress {
  const a = item.address ?? {};
  const iso = a['ISO3166-2-lvl4'] ?? '';
  return {
    latitude: Number(item.lat),
    longitude: Number(item.lon),
    label: item.display_name,
    postalCode: (a.postcode ?? '').replace(/\D/g, '').slice(0, 8),
    street: a.road ?? a.pedestrian ?? a.footway ?? '',
    streetNumber: a.house_number ?? '',
    district: a.suburb ?? a.neighbourhood ?? a.quarter ?? a.city_district ?? '',
    city: a.city ?? a.town ?? a.municipality ?? a.village ?? '',
    stateCode: iso.startsWith('BR-') ? iso.slice(3) : '',
  };
}

export async function searchAddress(query: string, signal?: AbortSignal): Promise<GeoAddress[]> {
  const q = query.trim();
  if (q.length < 4) return [];
  const url = `${BASE}/search?format=jsonv2&addressdetails=1&countrycodes=br&limit=5&accept-language=pt-BR&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocoding ${res.status}`);
  return ((await res.json()) as NominatimItem[]).map(toGeoAddress);
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<GeoAddress | null> {
  const url = `${BASE}/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=pt-BR&lat=${latitude}&lon=${longitude}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocoding ${res.status}`);
  const item = (await res.json()) as NominatimItem & { error?: string };
  if (item.error) return null;
  return { ...toGeoAddress(item), latitude, longitude };
}
