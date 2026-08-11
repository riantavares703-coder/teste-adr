import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  Field,
  Notice,
  defaultTheme,
  friendlyMessage,
  spacing,
} from '@plataforma/ui';
import { useSession } from '../session.js';

/**
 * ENTRADA DE OPERADOR E ADMINISTRADOR.
 *
 * Organização + e-mail + senha: o mesmo e-mail pode existir em franquias
 * diferentes, e a organização impede que uma credencial cruze de uma para a
 * outra. O servidor devolve a MESMA mensagem para senha errada, usuário
 * inexistente e conta bloqueada — a tela não pode virar oráculo de
 * enumeração de contas.
 *
 * Antes do login não existe marca a aplicar (a identidade é POR unidade, e a
 * unidade só se sabe depois de autenticar) — por isso esta tela usa o tema
 * padrão da plataforma, não um branding específico.
 */
export function LoginScreen() {
  const theme = defaultTheme;
  const { signIn } = useSession();
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn({
        organizationSlug: organizationSlug.trim().toLowerCase(),
        email: email.trim(),
        password,
      });
    } catch (e) {
      setError(friendlyMessage(e));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { backgroundColor: theme.background }]}
    >
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={[styles.logo, { backgroundColor: theme.primary }]}>
            <Text style={styles.logoGlyph}>🏬</Text>
          </View>
          <Text style={theme.font('title')}>Painel da loja</Text>
          <Text style={[theme.font('body'), { color: theme.mutedText, textAlign: 'center' }]}>
            Acesse com as credenciais da sua unidade.
          </Text>

          <Card>
            <View style={{ gap: spacing.md }}>
              <Field
                label="Organização"
                placeholder="ex.: acme"
                value={organizationSlug}
                onChangeText={setOrganizationSlug}
                autoCapitalize="none"
              />
              <Field
                label="E-mail"
                placeholder="voce@empresa.com"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
              />
              <Field
                label="Senha"
                placeholder="••••••••"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="current-password"
              />
            </View>
          </Card>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button
            label="Entrar"
            loading={busy}
            disabled={!organizationSlug.trim() || !email.trim() || password.length === 0}
            onPress={() => void submit()}
          />

          <Text style={[theme.font('caption'), { color: theme.mutedText, textAlign: 'center' }]}>
            Após várias tentativas incorretas, o acesso é bloqueado temporariamente.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  logoGlyph: { fontSize: 28 },
});
