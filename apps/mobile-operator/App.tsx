import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { LoadingState, defaultTheme } from '@plataforma/ui';
import { SessionProvider, useSession } from './src/session';
import { BranchProvider } from './src/branch-context';
import { LoginScreen } from './src/screens/LoginScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { OrdersScreen } from './src/screens/OrdersScreen';
import { InventoryScreen } from './src/screens/InventoryScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { AppearanceScreen } from './src/screens/AppearanceScreen';
import { FranchiseScreen } from './src/screens/FranchiseScreen';

import type { RootStackParamList } from './src/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * APP DO OPERADOR E DO ADMINISTRADOR.
 *
 * Duas das três experiências do sistema vivem aqui, separadas por PERMISSÃO,
 * não por build: quem só opera pedidos vê Dashboard/Orders/Inventory; quem
 * administra a unidade ou a franquia também vê Settings, Appearance e
 * Franchise. Todas as telas navegam livremente — é `SettingsScreen` quem
 * filtra o que aparece, a partir de `profile.permissions`.
 *
 * Esconder é conveniência. A recusa de verdade é sempre do servidor.
 */
function Routes() {
  const { isReady, isAuthenticated } = useSession();

  if (!isReady) return <LoadingState label="Verificando sessão…" />;
  if (!isAuthenticated) return <LoginScreen />;

  return (
    <BranchProvider>
      <NavigationContainer>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: defaultTheme.card },
            headerTintColor: defaultTheme.text,
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: defaultTheme.background },
          }}
        >
          <Stack.Screen name="Dashboard" component={DashboardScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Orders" component={OrdersScreen} options={{ title: 'Pedidos' }} />
          <Stack.Screen name="Inventory" component={InventoryScreen} options={{ title: 'Estoque virtual' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Configurações' }} />
          <Stack.Screen name="Appearance" component={AppearanceScreen} options={{ title: 'Aparência' }} />
          <Stack.Screen name="Franchise" component={FranchiseScreen} options={{ title: 'Indicadores' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </BranchProvider>
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
