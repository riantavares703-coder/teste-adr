import { describe, expect, it } from 'vitest';
import {
  describeOpenState,
  openState,
  parseTime,
  validateBusinessHours,
  type BusinessHour,
} from '../src/business-hours.js';

/** Segunda-feira, 12 de janeiro de 2026, no horário local. */
function at(weekday: number, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number);
  // 4 de janeiro de 2026 é um domingo; somamos o dia da semana desejado.
  return new Date(2026, 0, 4 + weekday, hours!, minutes!, 0, 0);
}

const SEG_A_SEX: BusinessHour[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday: weekday as BusinessHour['weekday'],
  opensAt: '11:00',
  closesAt: '15:00',
}));

describe('Horário de funcionamento', () => {
  describe('leitura de horário', () => {
    it('aceita HH:MM e o formato do PostgreSQL (HH:MM:SS)', () => {
      expect(parseTime('09:30')).toBe(570);
      expect(parseTime('09:30:00')).toBe(570);
    });

    it('recusa hora impossível', () => {
      expect(parseTime('25:00')).toBeNull();
      expect(parseTime('10:75')).toBeNull();
      expect(parseTime('abc')).toBeNull();
    });
  });

  describe('está aberta agora?', () => {
    it('aberta dentro da faixa', () => {
      expect(openState(SEG_A_SEX, at(1, '12:00')).isOpen).toBe(true);
    });

    it('fechada antes de abrir e depois de fechar', () => {
      expect(openState(SEG_A_SEX, at(1, '10:59')).isOpen).toBe(false);
      expect(openState(SEG_A_SEX, at(1, '15:00')).isOpen).toBe(false);
    });

    it('o minuto da abertura já conta como aberta; o do fechamento não', () => {
      // A faixa é fechada no início e aberta no fim: [abre, fecha).
      expect(openState(SEG_A_SEX, at(1, '11:00')).isOpen).toBe(true);
      expect(openState(SEG_A_SEX, at(1, '14:59')).isOpen).toBe(true);
    });

    it('fechada num dia sem faixa cadastrada', () => {
      expect(openState(SEG_A_SEX, at(0, '12:00')).isOpen).toBe(false);
    });

    it('sem NENHUM horário cadastrado, a loja é considerada aberta', () => {
      // Deliberado: quem ainda não configurou horário não pode ficar sem
      // vender por causa de uma configuração que não sabe que existe.
      const state = openState([], at(3, '03:00'));
      expect(state.isOpen).toBe(true);
      expect(state.hasSchedule).toBe(false);
    });
  });

  describe('faixa que atravessa a meia-noite', () => {
    const NOITE: BusinessHour[] = [{ weekday: 5, opensAt: '22:00', closesAt: '02:00' }];

    it('aberta antes da meia-noite', () => {
      expect(openState(NOITE, at(5, '23:30')).isOpen).toBe(true);
    });

    it('continua aberta depois da meia-noite, já no dia seguinte', () => {
      // Sábado 01:00 pertence à faixa que abriu na sexta às 22:00.
      expect(openState(NOITE, at(6, '01:00')).isOpen).toBe(true);
    });

    it('fecha na hora certa do dia seguinte', () => {
      expect(openState(NOITE, at(6, '02:00')).isOpen).toBe(false);
    });

    it('não abre no sábado à noite só porque a sexta virava', () => {
      expect(openState(NOITE, at(6, '23:00')).isOpen).toBe(false);
    });

    it('faixa do sábado que vira para domingo funciona na virada da semana', () => {
      // O caso que quebra implementações ingênuas: o intervalo passa do fim da
      // semana e reaparece no começo.
      const sabado: BusinessHour[] = [{ weekday: 6, opensAt: '20:00', closesAt: '03:00' }];
      expect(openState(sabado, at(6, '22:00')).isOpen).toBe(true);
      expect(openState(sabado, at(0, '01:00')).isOpen).toBe(true);
      expect(openState(sabado, at(0, '04:00')).isOpen).toBe(false);
    });
  });

  describe('próxima abertura', () => {
    it('aponta a próxima faixa do mesmo dia', () => {
      const state = openState(SEG_A_SEX, at(1, '09:00'));
      expect(state.isOpen).toBe(false);
      expect(state.next).toEqual({ weekday: 1, opensAt: '11:00', minutesUntil: 120 });
    });

    it('dá a volta na semana quando todas as faixas já passaram', () => {
      // Sexta 20:00: a próxima é segunda 11:00.
      const state = openState(SEG_A_SEX, at(5, '20:00'));
      expect(state.next?.weekday).toBe(1);
      expect(state.next?.minutesUntil).toBe(2 * 24 * 60 + 15 * 60);
    });
  });

  describe('texto para a tela', () => {
    it('aberta informa até quando', () => {
      expect(describeOpenState(openState(SEG_A_SEX, at(1, '12:00')))).toBe('Aberta até 15:00');
    });

    it('fechada há pouco informa em minutos', () => {
      expect(describeOpenState(openState(SEG_A_SEX, at(1, '10:30')))).toBe('Abre em 30 min');
    });

    it('fechada há muito informa o dia', () => {
      expect(describeOpenState(openState(SEG_A_SEX, at(5, '20:00')))).toBe('Abre segunda às 11:00');
    });

    it('sem horário cadastrado é dito explicitamente', () => {
      expect(describeOpenState(openState([], at(1, '12:00')))).toBe('Sem horário cadastrado');
    });
  });

  describe('validação antes de gravar', () => {
    it('aceita um conjunto coerente', () => {
      expect(validateBusinessHours(SEG_A_SEX)).toEqual([]);
    });

    it('recusa faixas sobrepostas no mesmo dia, explicando qual', () => {
      const issues = validateBusinessHours([
        { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
        { weekday: 1, opensAt: '14:00', closesAt: '18:00' },
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('Segunda');
      expect(issues[0]).toContain('se sobrepõem');
    });

    it('aceita duas faixas no mesmo dia quando não se tocam (almoço e jantar)', () => {
      expect(
        validateBusinessHours([
          { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
          { weekday: 1, opensAt: '18:00', closesAt: '23:00' },
        ]),
      ).toEqual([]);
    });

    it('faixas iguais em dias diferentes não conflitam', () => {
      expect(
        validateBusinessHours([
          { weekday: 1, opensAt: '11:00', closesAt: '15:00' },
          { weekday: 2, opensAt: '11:00', closesAt: '15:00' },
        ]),
      ).toEqual([]);
    });

    it('recusa horário inválido e abertura igual ao fechamento', () => {
      expect(validateBusinessHours([{ weekday: 1, opensAt: '99:00', closesAt: '15:00' }])).toHaveLength(1);
      expect(validateBusinessHours([{ weekday: 1, opensAt: '11:00', closesAt: '11:00' }])).toHaveLength(1);
    });

    it('recusa dia da semana fora da faixa', () => {
      expect(
        validateBusinessHours([{ weekday: 9 as BusinessHour['weekday'], opensAt: '11:00', closesAt: '15:00' }]),
      ).toHaveLength(1);
    });
  });
});
