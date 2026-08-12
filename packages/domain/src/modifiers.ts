/**
 * REGRA DE ESCOLHA DE OPÇÕES.
 *
 * O lojista define a pergunta ("Tamanho") e como respondê-la: obrigatória ou
 * não, quantas no mínimo, quantas no máximo. Esta função aplica essa regra.
 *
 * Mora no domínio porque os dois lados precisam dela pelo MESMO critério: a
 * tela usa para desabilitar o botão e explicar o que falta; o checkout usa para
 * RECUSAR. Duas implementações divergiriam, e a que vale é a do servidor —
 * então é ela que precisa existir primeiro.
 */

export interface ModifierRule {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
  /** Ids das opções que pertencem a este grupo. */
  optionIds: readonly string[];
}

export type SelectionCheck = { ok: true } | { ok: false; message: string };

export function validateModifierSelection(
  groups: readonly ModifierRule[],
  selectedIds: readonly string[],
): SelectionCheck {
  const chosen = new Set(selectedIds);

  for (const group of groups) {
    const count = group.optionIds.filter((id) => chosen.has(id)).length;

    // "Obrigatório" sem mínimo declarado significa ao menos um — senão o grupo
    // seria obrigatório e ainda assim aceitaria nenhuma escolha.
    const minimum = group.isRequired ? Math.max(1, group.minSelect) : group.minSelect;

    if (count < minimum) {
      return {
        ok: false,
        message:
          minimum === 1
            ? `Escolha uma opção em "${group.name}"`
            : `Escolha ao menos ${minimum} opções em "${group.name}"`,
      };
    }

    if (count > group.maxSelect) {
      return {
        ok: false,
        message:
          group.maxSelect === 1
            ? `"${group.name}" aceita apenas uma opção`
            : `"${group.name}" aceita no máximo ${group.maxSelect} opções`,
      };
    }
  }

  return { ok: true };
}
