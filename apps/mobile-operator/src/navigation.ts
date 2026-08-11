import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/** Rotas do app de operação. */
export type RootStackParamList = {
  Dashboard: undefined;
  Inventory: undefined;
  Admin: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;
