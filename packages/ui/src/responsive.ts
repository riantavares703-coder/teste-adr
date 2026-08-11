import { useWindowDimensions } from 'react-native';
import { spacing } from './theme.js';

/**
 * RESPONSIVIDADE (item 13).
 *
 * "Evitar dimensões fixas que quebrem a interface" — na prática, isso quer
 * dizer que nenhuma tela pode assumir a largura de um aparelho específico.
 *
 * Usamos `useWindowDimensions` e não `Dimensions.get()`: o segundo lê UMA vez
 * e não reage a rotação nem a split-screen no Android/iPad, o que produz
 * exatamente o layout quebrado que o item pede para evitar.
 */

export type Breakpoint = 'compact' | 'regular' | 'large' | 'tablet';

/**
 * Cortes escolhidos por aparelho real, não por número redondo:
 *  - 360pt cobre iPhone SE e Androids pequenos;
 *  - 414pt é a faixa dos "Plus/Pro Max";
 *  - 768pt em diante é tablet, onde uma coluna só desperdiça a tela.
 */
export function breakpointFor(width: number): Breakpoint {
  if (width >= 768) return 'tablet';
  if (width >= 414) return 'large';
  if (width >= 360) return 'regular';
  return 'compact';
}

export interface Responsive {
  width: number;
  height: number;
  breakpoint: Breakpoint;
  isCompact: boolean;
  isTablet: boolean;
  /** Colunas do cardápio: uma no celular, duas ou três em telas largas. */
  menuColumns: number;
  /** Colunas dos cartões de indicador no painel. */
  statColumns: number;
  /** Margem lateral da tela — cresce com a largura para não esticar o texto. */
  gutter: number;
  /** Largura máxima do conteúdo, para o texto não virar uma linha larguíssima. */
  maxContentWidth: number;
  /** Altura da foto do produto no card, proporcional à largura disponível. */
  cardImageHeight: number;
}

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const breakpoint = breakpointFor(width);
  const isTablet = breakpoint === 'tablet';

  const gutter = isTablet ? spacing.xl : breakpoint === 'compact' ? spacing.md : spacing.lg;
  const menuColumns = width >= 1024 ? 3 : isTablet ? 2 : 1;
  const statColumns = isTablet ? 4 : breakpoint === 'compact' ? 2 : 2;

  // A foto acompanha a largura da coluna numa proporção próxima de 16:9 e é
  // limitada nos extremos: nem uma fatia fina no celular pequeno, nem meia
  // tela num tablet.
  const columnWidth = (Math.min(width, 1200) - gutter * 2) / menuColumns;
  const cardImageHeight = Math.round(Math.max(140, Math.min(columnWidth * 0.56, 260)));

  return {
    width,
    height,
    breakpoint,
    isCompact: breakpoint === 'compact',
    isTablet,
    menuColumns,
    statColumns,
    gutter,
    maxContentWidth: 1200,
    cardImageHeight,
  };
}
