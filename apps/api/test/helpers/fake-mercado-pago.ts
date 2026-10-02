import { vi } from 'vitest';

export const VALID_TOKEN = 'APP_USR-1234567890-valid-token-abcd';

export interface FakePayment {
  id: number;
  status: string;
  transaction_amount: number;
  external_reference: string;
}

/** Mercado Pago falso: o código sob teste faz `fetch` de verdade contra ele. */
export function installFakeMercadoPago() {
  const payments = new Map<string, FakePayment>();
  const state = { down: false, nextId: 9000, created: [] as Array<Record<string, unknown>> };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (state.down) throw new Error('connect ECONNREFUSED');
      const path = new URL(url).pathname;
      const auth = (init.headers as Record<string, string>).Authorization;
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

      if (auth !== `Bearer ${VALID_TOKEN}`) return json(401, { message: 'invalid_token' });
      if (path === '/users/me') return json(200, { id: 1 });

      if (path === '/v1/payments' && init.method === 'POST') {
        const body = JSON.parse(init.body as string);
        state.created.push(body);
        const p: FakePayment = {
          id: state.nextId++,
          status: 'pending',
          transaction_amount: body.transaction_amount,
          external_reference: body.external_reference,
        };
        payments.set(String(p.id), p);
        return json(201, {
          ...p,
          point_of_interaction: { transaction_data: { qr_code: `00020126MPCODE${p.id}` } },
        });
      }

      const match = path.match(/^\/v1\/payments\/(\d+)$/);
      if (match && payments.has(match[1]!)) return json(200, payments.get(match[1]!));
      return json(404, { message: 'not_found' });
    }),
  );
  return { payments, state };
}

