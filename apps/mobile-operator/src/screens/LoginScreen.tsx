import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Notice, palette, radius, spacing, typography } from '@plataforma/ui';
import { useSession } from '../session.js';

/**
 * Entrada de operador e administrador: organização + e-mail + senha.
 *
 * A organização faz parte da credencial porque o mesmo e-mail pode existir em
 * franquias diferentes — e nunca deve cruzar de uma para a outra. O servidor
 * devolve a MESMA mensagem para senha errada, usuário inexistente e conta
 * bloqueada: a tela não pode ser um oráculo de enumeração.
 */
export function LoginScreen() {
  const { api, refreshProfile } = useSession();
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.loginStaff({
        organizationSlug: organizationSlug.trim().toLowerCase(),
        email: email.trim(),
        password,
      });
      await refreshProfile();
    } catch (e) {
      setError((e as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <View style={styles.content}>
        <Text style={typography.title}>Painel do operador</Text>
        <Text style={typography.caption}>Acesse com as credenciais da sua unidade.</Text>

        <TextInput
          accessibilityLabel="Identificador da organização"
          placeholder="Organização (ex.: acme)"
          placeholderTextColor={palette.ink500}
          autoCapitalize="none"
          autoCorrect={false}
          value={organizationSlug}
          onChangeText={setOrganizationSlug}
          style={styles.input}
        />
        <TextInput
          accessibilityLabel="E-mail"
          placeholder="E-mail"
          placeholderTextColor={palette.ink500}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
          style={styles.input}
        />
        <TextInput
          accessibilityLabel="Senha"
          placeholder="Senha"
          placeholderTextColor={palette.ink500}
          // secureTextEntry + sem autocorreção: a senha não vai para o
          // dicionário do teclado nem aparece em sugestão.
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          value={password}
          onChangeText={setPassword}
          style={styles.input}
        />

        <Button
          label={busy ? 'Entrando…' : 'Entrar'}
          loading={busy}
          disabled={!organizationSlug.trim() || !email.trim() || password.length === 0}
          onPress={() => void submit()}
        />

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Text style={[typography.caption, styles.hint]}>
          Após várias tentativas incorretas, o acesso é bloqueado temporariamente.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.white },
  content: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  input: {
    borderWidth: 1,
    borderColor: palette.ink300,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 52,
    fontSize: 16,
    color: palette.ink900,
  },
  hint: { textAlign: 'center', marginTop: spacing.md },
});
