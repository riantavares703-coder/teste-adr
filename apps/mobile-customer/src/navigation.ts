import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BranchSummary, Menu } from '@plataforma/client';

/**
 * Rotas do app do cliente — o fluxo do item 6, sem tela desnecessária.
 *
 *   Branches → Menu → Product → Cart → Checkout → Payment → Tracking
 *
 * "Adicionar" NÃO é tela: acontece no card do cardápio (item simples) ou na
 * folha de opções (item com adicionais). Cada tela a menos entre o cliente e o
 * pedido é conversão.
 *
 * `Menu` viaja pelos parâmetros porque carrega o TEMA da loja: navegar sem ele
 * faria a tela seguinte piscar com a marca padrão antes de recarregar.
 */
export type RootStackParamList = {
  Branches: undefined;
  Menu: { branch: BranchSummary };
  Product: { productId: string; menu: Menu };
  Cart: { menu: Menu };
  Checkout: { menu: Menu };
  Payment: { orderId: string; menu: Menu };
  Tracking: { orderId: string; menu: Menu };
  Login: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;
