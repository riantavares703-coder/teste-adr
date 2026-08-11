import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Loading, palette } from '@plataforma/ui';
import { SessionProvider, useSession } from './src/session';
import { LoginScreen } from './src/screens/LoginScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { InventoryScreen } from './src/screens/InventoryScreen';
import { AdminScreen } from './src/screens/AdminScreen';

import type { RootStackParamList } from './src/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * APP DO OPERADOR E DO ADMINISTRADOR.
 *
 * Duas das três experiências do sistema vivem aqui, separadas por PERMISSÃO,
 * não por build:
 *
 *  - OPERADOR: fila de pedidos, transições de status, estoque virtual,
 *    confirmação de recebimento de Pix.
 *  - ADMINISTRADOR: tudo acima + catálogo, preço e chave Pix.
 *
 * A aba "Administração" só aparece para quem tem as permissões — e mesmo que
 * alguém force a navegação, o servidor recusa com 403. Esconder botão é
 * conveniência; a autorização é sempre do lado do servidor.
 */
function Routes() {
  const { isReady, isAuthenticated, profile } = useSession();

  if (!isReady) return <Loading label="Verificando sessão…" />;
  if (!isAuthenticated) return <LoginScreen />;

  const isAdmin =
    profile?.permissions.includes('product:create') ||
    profile?.permissions.includes('pix_settings:update');

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: palette.white },
          headerTintColor: palette.ink900,
          headerTitleStyle: { fontWeight: '700' },
        }}
      >
        <Stack.Screen
          name="Dashboard"
          component={DashboardScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Inventory"
          component={InventoryScreen}
          options={{ title: 'Estoque virtual' }}
        />
        {isAdmin ? (
          <Stack.Screen
            name="Admin"
            component={AdminScreen}
            options={{ title: 'Administração' }}
          />
        ) : null}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Routes />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
