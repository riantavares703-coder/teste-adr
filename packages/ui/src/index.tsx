/**
 * @plataforma/ui — sistema visual compartilhado pelos aplicativos.
 *
 * Três camadas:
 *
 *   theme       tokens + tema em tempo de execução vindo do branding da unidade
 *   motion      microinterações que respeitam "reduzir movimento"
 *   components  a biblioteca em si
 *   states      LOADING / EMPTY / ERROR / OFFLINE / SESSÃO / PERMISSÃO
 *   responsive  celular pequeno, celular grande e tablet
 *
 * Nenhum componente daqui fala com a rede nem conhece navegação. Isso mantém
 * o mesmo card renderizável tanto na tela real quanto no preview do editor de
 * aparência — que é o requisito do item 4.
 */
export * from './theme.js';
export * from './motion.js';
export * from './components.js';
export * from './states.js';
export * from './responsive.js';
