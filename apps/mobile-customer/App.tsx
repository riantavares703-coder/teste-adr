import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, defaultTheme } from '@plataforma/ui';
import { SessionProvider } from './src/session';
import { CartProvider } from './src/cart-context';
import { BranchesScreen } from './src/screens/BranchesScreen';
import { MenuScreen } from './src/screens/MenuScreen';
import { ProductScreen } from './src/screens/ProductScreen';
import { CartScreen } from './src/screens/CartScreen';
import { CheckoutScreen } from './src/screens/CheckoutScreen';
import { PaymentScreen } from './src/screens/PaymentScreen';
import { TrackingScreen } from './src/screens/TrackingScreen';
import { LoginScreen } from './src/screens/LoginScreen';

import type { RootStackParamList } from './src/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * APP DO CLIENTE.
 *
 * O `ThemeProvider` da raiz usa o tema PADRÃO da plataforma — antes de
 * escolher a unidade, não existe marca a aplicar. Cada tela de dentro da loja
 * instala o próprio provider com o tema que veio do servidor.
 *
 * Fazer o inverso (tema global mutável) traria dois problemas: a tela de
 * escolha de unidade piscaria com as cores da última loja visitada, e o
 * preview do administrador precisaria de um "modo" global só para existir.
 */
function Navigation() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          // Empurrar da direita é o gesto que o usuário espera de "avançar" nas
          // duas plataformas, e mantém o gesto de voltar do iOS funcionando.
          animation: 'slide_from_right',
          contentStyle: { backgroundColor: defaultTheme.background },
        }}
      >
        <Stack.Screen name="Branches" component={BranchesScreen} />
        <Stack.Screen name="Menu" component={MenuScreen} />
        <Stack.Screen
          name="Product"
          component={ProductScreen}
          options={{ headerShown: true, title: '', headerTransparent: true, headerBackTitle: '' }}
        />
        <Stack.Screen
          name="Cart"
          component={CartScreen}
          options={{ headerShown: true, title: 'Carrinho' }}
        />
        <Stack.Screen
          name="Checkout"
          component={CheckoutScreen}
          options={{ headerShown: true, title: 'Finalizar pedido' }}
        />
        <Stack.Screen
          name="Payment"
          component={PaymentScreen}
          options={{ headerShown: true, title: 'Pagamento' }}
        />
        <Stack.Screen
          name="Tracking"
          component={TrackingScreen}
          options={{ headerShown: true, title: 'Seu pedido' }}
        />
        <Stack.Screen
          name="Login"
          component={LoginScreen}
          // Modal: entrar é um desvio do fluxo, não um passo dele. O cliente
          // volta exatamente para onde estava.
          options={{ presentation: 'modal', headerShown: true, title: 'Entrar' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SessionProvider>
          <CartProvider>
            <StatusBar style="light" />
            <Navigation />
          </CartProvider>
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
