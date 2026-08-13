import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

/**
 * TEMPO REAL.
 *
 * O backend já publica `order.created`, `order.status_changed` e
 * `payment.confirmed` nas salas `branch:{id}` e `order:{id}`. Faltava escutar.
 *
 * Por que isto importa mais do que parece: com consulta periódica, o pedido do
 * cliente leva até 10 segundos para aparecer na fila do balcão, e o cliente
 * espera até 15 para ver que o pedido ficou pronto. São dois lugares onde a
 * pessoa fica olhando para uma tela que já está desatualizada.
 *
 * A consulta periódica CONTINUA existindo como rede de segurança, só que
 * bem mais espaçada: se o socket cair no meio do movimento, a tela não pode
 * congelar em silêncio.
 */
export type RealtimeStatus = 'conectando' | 'conectado' | 'desconectado';

export interface RealtimeRoom {
  /** Fila da unidade — exige staff com escopo nela. */
  branchId?: string;
  /** Acompanhamento de um pedido — exige ser o dono ou staff com escopo. */
  orderId?: string;
}

/**
 * @param getToken devolve o access token atual. É função, e não string, porque
 *   o token é curto e renova: guardar o valor deixaria o socket preso a um
 *   token vencido na primeira reconexão.
 */
export function useRealtime(
  getToken: () => string | null,
  room: RealtimeRoom,
  onEvent: (event: string, payload: unknown) => void,
): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('conectando');

  // O callback muda a cada render; guardá-lo numa ref evita derrubar e refazer
  // a conexão a cada atualização de estado da tela.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  const tokenReader = useRef(getToken);
  tokenReader.current = getToken;

  const { branchId, orderId } = room;

  useEffect(() => {
    if (!branchId && !orderId) return;

    const token = tokenReader.current();
    if (!token) {
      setStatus('desconectado');
      return;
    }

    let socket: Socket | null = null;
    let disposed = false;

    // Mesma origem da API: uma porta só, sem CORS e sem configuração de
    // endereço para o dono do restaurante errar.
    socket = io(window.location.origin, {
      transports: ['websocket'],
      // No handshake, nunca na query string: query string vaza em log de proxy
      // e no histórico do navegador.
      auth: { token },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });

    socket.on('connect', () => {
      if (disposed) return;
      setStatus('conectado');
      // A entrada na sala é reautorizada no servidor; o retorno diz se passou.
      if (branchId) socket?.emit('join:branch', { branchId });
      if (orderId) socket?.emit('join:order', { orderId, branchId });
    });

    socket.on('disconnect', () => !disposed && setStatus('desconectado'));
    socket.on('connect_error', () => !disposed && setStatus('desconectado'));

    for (const event of ['order.created', 'order.status_changed', 'payment.confirmed']) {
      socket.on(event, (payload: unknown) => handler.current(event, payload));
    }

    return () => {
      disposed = true;
      socket?.removeAllListeners();
      socket?.disconnect();
    };
  }, [branchId, orderId]);

  return status;
}

/**
 * Aviso sonoro curto para pedido novo.
 *
 * Gerado pela Web Audio API em vez de um arquivo: não há o que baixar, funciona
 * sem internet e não acrescenta um binário ao pacote por causa de um bipe.
 *
 * Navegadores só permitem áudio depois de uma interação do usuário. Como o
 * operador precisa fazer login antes de ver a fila, essa interação já
 * aconteceu — e, se ainda assim for bloqueado, o erro é engolido: som é
 * reforço, o destaque visual é que carrega a informação.
 */
export function playNewOrderChime(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const now = ctx.currentTime;

    // Duas notas ascendentes: reconhecível sem ser alarme.
    for (const [index, frequency] of [880, 1174.66].entries()) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;

      const start = now + index * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.3);
    }

    setTimeout(() => void ctx.close(), 800);
  } catch {
    // Sem áudio disponível: o realce visual do pedido novo continua valendo.
  }
}
