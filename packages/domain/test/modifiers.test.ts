import { describe, expect, it } from 'vitest';
import { validateModifierSelection, type ModifierRule } from '../src/modifiers.js';

const TAMANHO: ModifierRule = {
  id: 'g1',
  name: 'Tamanho',
  minSelect: 1,
  maxSelect: 1,
  isRequired: true,
  optionIds: ['simples', 'duplo'],
};

const ADICIONAIS: ModifierRule = {
  id: 'g2',
  name: 'Adicionais',
  minSelect: 0,
  maxSelect: 3,
  isRequired: false,
  optionIds: ['bacon', 'ovo', 'cheddar', 'salada'],
};

describe('Regra de escolha de opções', () => {
  it('aceita a escolha obrigatória feita', () => {
    expect(validateModifierSelection([TAMANHO], ['duplo'])).toEqual({ ok: true });
  });

  it('recusa quando o grupo obrigatório não foi respondido', () => {
    // O furo que motivou este arquivo: a tela impedia, mas uma chamada direta
    // à API criava o pedido sem a escolha.
    const check = validateModifierSelection([TAMANHO], []);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toContain('Tamanho');
  });

  it('recusa mais escolhas que o máximo', () => {
    const check = validateModifierSelection([TAMANHO], ['simples', 'duplo']);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toContain('apenas uma');
  });

  it('grupo opcional aceita nenhuma escolha', () => {
    expect(validateModifierSelection([ADICIONAIS], [])).toEqual({ ok: true });
  });

  it('grupo opcional respeita o teto', () => {
    expect(validateModifierSelection([ADICIONAIS], ['bacon', 'ovo', 'cheddar'])).toEqual({
      ok: true,
    });
    const check = validateModifierSelection([ADICIONAIS], ['bacon', 'ovo', 'cheddar', 'salada']);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toContain('no máximo 3');
  });

  it('obrigatório sem mínimo declarado exige ao menos um', () => {
    // Sem isto o grupo seria "obrigatório" e ainda assim aceitaria vazio.
    const semMinimo: ModifierRule = { ...TAMANHO, minSelect: 0 };
    expect(validateModifierSelection([semMinimo], []).ok).toBe(false);
  });

  it('exige o mínimo quando ele é maior que um', () => {
    const doisSabores: ModifierRule = {
      id: 'g3',
      name: 'Sabores',
      minSelect: 2,
      maxSelect: 2,
      isRequired: true,
      optionIds: ['a', 'b', 'c'],
    };
    const check = validateModifierSelection([doisSabores], ['a']);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toContain('ao menos 2');
    expect(validateModifierSelection([doisSabores], ['a', 'b'])).toEqual({ ok: true });
  });

  it('avalia todos os grupos, não só o primeiro', () => {
    const check = validateModifierSelection([TAMANHO, ADICIONAIS], [
      'duplo',
      'bacon',
      'ovo',
      'cheddar',
      'salada',
    ]);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.message).toContain('Adicionais');
  });

  it('ignora ids que não pertencem a nenhum grupo do produto', () => {
    // O vínculo opção-produto é conferido à parte pelo servidor; aqui um id
    // estranho não pode fazer um grupo obrigatório parecer respondido.
    const check = validateModifierSelection([TAMANHO], ['opcao-de-outro-produto']);
    expect(check.ok).toBe(false);
  });

  it('sem grupos, qualquer coisa passa', () => {
    expect(validateModifierSelection([], [])).toEqual({ ok: true });
  });
});
