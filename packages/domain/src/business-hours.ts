/**
 * HORÁRIO DE FUNCIONAMENTO.
 *
 * Decide se a loja está aberta. Mora no domínio, sem I/O, porque a mesma
 * resposta é necessária em três lugares: o cardápio do cliente (para avisar), o
 * painel do operador (para mostrar o estado) e o checkout (para RECUSAR). Os
 * dois primeiros são conveniência; o terceiro é a regra, e é no servidor.
 */

export const WEEKDAYS = [
  'Domingo',
  'Segunda',
  'Terça',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sábado',
] as const;

/** 0 = domingo, seguindo `Date.getDay()` e a coluna `weekday` do banco. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface BusinessHour {
  weekday: Weekday;
  /** `HH:MM` em 24h. */
  opensAt: string;
  closesAt: string;
}

export interface OpenState {
  isOpen: boolean;
  /** Faixa que está valendo agora, quando aberta. */
  current: BusinessHour | null;
  /** Próxima abertura, quando fechada. `null` se não há horário cadastrado. */
  next: { weekday: Weekday; opensAt: string; minutesUntil: number } | null;
  /** Sem nenhuma faixa cadastrada: a loja não declara horário. */
  hasSchedule: boolean;
}

const MINUTES_IN_DAY = 24 * 60;

/** `HH:MM` (aceita `HH:MM:SS`, como o PostgreSQL devolve) → minutos do dia. */
export function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatTime(minutesOfDay: number): string {
  const normalized = ((minutesOfDay % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Uma faixa vira um intervalo absoluto de minutos desde o domingo 00:00.
 *
 * Faixa que fecha ANTES de abrir (22:00–02:00) atravessa a meia-noite e
 * pertence ao dia seguinte — sem isso, a lanchonete que fecha às 2h ficaria
 * "fechada" justamente nas horas em que mais vende.
 */
function toAbsoluteRange(hour: BusinessHour): { start: number; end: number } | null {
  const opens = parseTime(hour.opensAt);
  const closes = parseTime(hour.closesAt);
  if (opens === null || closes === null) return null;

  const start = hour.weekday * MINUTES_IN_DAY + opens;
  const end =
    closes > opens
      ? hour.weekday * MINUTES_IN_DAY + closes
      : hour.weekday * MINUTES_IN_DAY + closes + MINUTES_IN_DAY;
  return { start, end };
}

const WEEK_MINUTES = 7 * MINUTES_IN_DAY;

/** Minuto da semana correspondente a um instante. */
function weekMinuteOf(now: Date): number {
  return now.getDay() * MINUTES_IN_DAY + now.getHours() * 60 + now.getMinutes();
}

/**
 * Estado de abertura da loja.
 *
 * Sem nenhuma faixa cadastrada, devolve ABERTA. É deliberado: um lojista que
 * ainda não configurou horário não pode ter as vendas bloqueadas por uma
 * configuração que ele não sabe que existe. `hasSchedule` deixa o caso
 * distinguível para a tela avisar.
 */
export function openState(hours: readonly BusinessHour[], now: Date = new Date()): OpenState {
  const ranges = hours
    .map((hour) => ({ hour, range: toAbsoluteRange(hour) }))
    .filter((entry): entry is { hour: BusinessHour; range: { start: number; end: number } } =>
      entry.range !== null,
    );

  if (ranges.length === 0) {
    return { isOpen: true, current: null, next: null, hasSchedule: false };
  }

  const nowMinute = weekMinuteOf(now);

  for (const { hour, range } of ranges) {
    // A faixa que atravessa a meia-noite do sábado reaparece no início da
    // semana; testamos o instante atual e o mesmo instante uma semana à frente.
    const inRange =
      (nowMinute >= range.start && nowMinute < range.end) ||
      (nowMinute + WEEK_MINUTES >= range.start && nowMinute + WEEK_MINUTES < range.end);
    if (inRange) {
      return { isOpen: true, current: hour, next: null, hasSchedule: true };
    }
  }

  // Fechada: a próxima abertura é o menor início ainda à frente, dando a volta
  // na semana quando todos já passaram.
  let best: { weekday: Weekday; opensAt: string; minutesUntil: number } | null = null;
  for (const { hour, range } of ranges) {
    const delta = range.start >= nowMinute ? range.start - nowMinute : range.start + WEEK_MINUTES - nowMinute;
    if (!best || delta < best.minutesUntil) {
      best = { weekday: hour.weekday, opensAt: formatTime(parseTime(hour.opensAt)!), minutesUntil: delta };
    }
  }

  return { isOpen: false, current: null, next: best, hasSchedule: true };
}

/** Texto curto para a tela: "Aberta até 23:00" / "Abre segunda às 18:00". */
export function describeOpenState(state: OpenState): string {
  if (!state.hasSchedule) return 'Sem horário cadastrado';
  if (state.isOpen) {
    return state.current ? `Aberta até ${formatTime(parseTime(state.current.closesAt)!)}` : 'Aberta';
  }
  if (!state.next) return 'Fechada';
  if (state.next.minutesUntil < 60) return `Abre em ${state.next.minutesUntil} min`;
  return `Abre ${WEEKDAYS[state.next.weekday].toLowerCase()} às ${state.next.opensAt}`;
}

/**
 * Valida um conjunto de faixas antes de gravar.
 *
 * O banco já recusa sobreposição (constraint EXCLUDE) e fim antes do início,
 * mas uma violação de constraint chega como erro de banco, não como mensagem
 * para o lojista. Aqui a recusa é explicável.
 */
export function validateBusinessHours(hours: readonly BusinessHour[]): string[] {
  const issues: string[] = [];

  hours.forEach((hour, index) => {
    const position = `Faixa ${index + 1}`;
    if (hour.weekday < 0 || hour.weekday > 6 || !Number.isInteger(hour.weekday)) {
      issues.push(`${position}: dia da semana inválido`);
      return;
    }
    const opens = parseTime(hour.opensAt);
    const closes = parseTime(hour.closesAt);
    if (opens === null) issues.push(`${position}: horário de abertura inválido`);
    if (closes === null) issues.push(`${position}: horário de fechamento inválido`);
    if (opens !== null && closes !== null && opens === closes) {
      issues.push(`${position}: abertura e fechamento não podem ser iguais`);
    }
  });

  // Sobreposição no MESMO dia. Faixas que viram a meia-noite pertencem ao dia
  // em que abrem, então a comparação por dia é suficiente aqui.
  for (let i = 0; i < hours.length; i++) {
    for (let j = i + 1; j < hours.length; j++) {
      const a = hours[i]!;
      const b = hours[j]!;
      if (a.weekday !== b.weekday) continue;
      const rangeA = toAbsoluteRange(a);
      const rangeB = toAbsoluteRange(b);
      if (!rangeA || !rangeB) continue;
      if (rangeA.start < rangeB.end && rangeB.start < rangeA.end) {
        issues.push(
          `${WEEKDAYS[a.weekday]}: os horários ${a.opensAt}–${a.closesAt} e ${b.opensAt}–${b.closesAt} se sobrepõem`,
        );
      }
    }
  }

  return issues;
}
