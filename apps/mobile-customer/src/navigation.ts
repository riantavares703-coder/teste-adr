import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { Menu } from '@plataforma/client';

/**
 * Tipagem das rotas.
 *
 * Sem isto, `navigation.navigate('Payment', { pedido })` compila com qualquer
 * parâmetro e quebra só em tempo de execução. Com o ParamList, errar o nome da
 * tela ou o formato dos parâmetros vira erro de compilação.
 */
export type RootStackParamList = {
  Menu: undefined;
  Product: { productId: string; menu: Menu };
  Cart: { menu: Menu };
  Payment: { orderId: string; menu: Menu };
  Tracking: { orderId: string; menu: Menu };
  Login: { returnTo?: keyof RootStackParamList } | undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;
