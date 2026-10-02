const RULES: Array<[RegExp, string]> = [
  [/hamb|burger|x-|lanche|sandu/i, '🍔'],
  [/pizza/i, '🍕'],
  [/batata|fritas|porç/i, '🍟'],
  [/hot ?dog|cachorro/i, '🌭'],
  [/salada/i, '🥗'],
  [/suco|refri|bebida|água|agua|coca|guaran|chá|cha /i, '🥤'],
  [/cerveja|chopp/i, '🍺'],
  [/café|cafe|capuc/i, '☕'],
  [/sorvete|açaí|acai/i, '🍨'],
  [/brownie|bolo|torta|doce|pudim|sobremesa|mousse/i, '🍰'],
  [/pastel|salgad|coxinha|empada/i, '🥟'],
  [/frango|galeto/i, '🍗'],
  [/massa|macarr|lasanha|espaguete/i, '🍝'],
  [/sushi|temaki|japon/i, '🍣'],
  [/carne|churrasc|picanha|bife/i, '🥩'],
];

/** Emoji de apoio quando o produto não tem foto — só pelo nome, sem inventar conteúdo. */
export function foodEmoji(...texts: Array<string | null | undefined>): string {
  const haystack = texts.filter(Boolean).join(' ');
  for (const [pattern, emoji] of RULES) if (pattern.test(haystack)) return emoji;
  return '🍽️';
}
