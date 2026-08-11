import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { palette } from '@plataforma/ui';
import { SessionProvider } from './src/session';
import { CartProvider } from './src/cart-context';
import { MenuScreen } from './src/screens/MenuScreen';
import { ProductScreen } from './src/screens/ProductScreen';
import { CartScreen } from './src/screens/CartScreen';
import { PaymentScreen } from './src/screens/PaymentScreen';
import { TrackingScreen } from './src/screens/TrackingScreen';
import { LoginScreen } from './src/screens/LoginScreen';

import type { RootStackParamList } from './src/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * APP DO CLIENTE.
 *
 * Experiência distinta das outras duas: vitrine, cardápio, carrinho, checkout,
 * pagamento e acompanhamento. Não existe nenhuma tela de operação aqui — e o
 * servidor não aceitaria as chamadas mesmo que existissem, porque o papel
 * CUSTOMER só tem `order:create`, `order:read_own` e `order:cancel`.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <CartProvider>
          <StatusBar style="light" />
          <NavigationContainer>
            <Stack.Navigator
              screenOptions={{
                headerStyle: { backgroundColor: palette.white },
                headerTintColor: palette.ink900,
                headerTitleStyle: { fontWeight: '700' },
                contentStyle: { backgroundColor: palette.ink100 },
              }}
            >
              <Stack.Screen
                name="Menu"
                component={MenuScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="Product"
                component={ProductScreen}
                options={{ title: 'Produto' }}
              />
              <Stack.Screen name="Cart" component={CartScreen} options={{ title: 'Seu carrinho' }} />
              <Stack.Screen
                name="Payment"
                component={PaymentScreen}
                options={{ title: 'Pagamento', headerBackVisible: false }}
              />
              <Stack.Screen
                name="Tracking"
                component={TrackingScreen}
                options={{ title: 'Acompanhar pedido' }}
              />
              <Stack.Screen
                name="Login"
                component={LoginScreen}
                options={{ title: 'Entrar', presentation: 'modal' }}
              />
            </Stack.Navigator>
          </NavigationContainer>
        </CartProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
