import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Notice, palette, radius, spacing, typography } from '@plataforma/ui';
import { useSession } from '../session.js';
import type { ScreenProps } from '../navigation.js';

/**
 * Entrada do cliente por telefone + código (item 3 da arquitetura de auth).
 *
 * Sem senha: elimina de uma vez credential stuffing, senha reutilizada e todo o
 * fluxo de "esqueci a senha" — historicamente a superfície mais atacada de um
 * app de consumo. O telefone já é necessário para entrega e WhatsApp.
 */
export function LoginScreen({ navigation, route }: ScreenProps<'Login'>) {
  const { api, refreshProfile } = useSession();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function normalizePhone(input: string): string {
    const digits = input.replace(/\D/g, '');
    return digits.startsWith('55') ? `+${digits}` : `+55${digits}`;
  }

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      await api.requestOtp(normalizePhone(phone));
      setStep('code');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await api.verifyOtp({
        phone: normalizePhone(phone),
        code: code.trim(),
        fullName: fullName.trim() || undefined,
      });
      await refreshProfile();
      navigation.goBack();
    } catch (e) {
      setError((e as Error).message);
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
        <Text style={typography.title}>
          {step === 'phone' ? 'Entrar' : 'Confirme o código'}
        </Text>
        <Text style={typography.caption}>
          {step === 'phone'
            ? 'Enviaremos um código de 6 dígitos para o seu WhatsApp.'
            : `Digite o código enviado para ${normalizePhone(phone)}.`}
        </Text>

        {step === 'phone' ? (
          <>
            <TextInput
              accessibilityLabel="Telefone"
              placeholder="(11) 99999-9999"
              placeholderTextColor={palette.ink500}
              keyboardType="phone-pad"
              autoComplete="tel"
              value={phone}
              onChangeText={setPhone}
              style={styles.input}
            />
            <Button
              label={busy ? 'Enviando…' : 'Receber código'}
              loading={busy}
              disabled={phone.replace(/\D/g, '').length < 10}
              onPress={() => void requestCode()}
            />
          </>
        ) : (
          <>
            <TextInput
              accessibilityLabel="Código de verificação"
              placeholder="000000"
              placeholderTextColor={palette.ink500}
              keyboardType="number-pad"
              // Preenchimento automático do SMS, sem sugestão de teclado.
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              autoCorrect={false}
              maxLength={6}
              value={code}
              onChangeText={setCode}
              style={[styles.input, styles.codeInput]}
            />
            <TextInput
              accessibilityLabel="Seu nome"
              placeholder="Seu nome (para o primeiro acesso)"
              placeholderTextColor={palette.ink500}
              value={fullName}
              onChangeText={setFullName}
              style={styles.input}
            />
            <Button
              label={busy ? 'Verificando…' : 'Entrar'}
              loading={busy}
              disabled={code.trim().length !== 6}
              onPress={() => void verify()}
            />
            <Button label="Trocar telefone" variant="ghost" onPress={() => setStep('phone')} />
          </>
        )}

        {error ? <Notice tone="danger">{error}</Notice> : null}
        {route.params?.returnTo ? (
          <Text style={typography.caption}>
            Depois de entrar, você volta para finalizar o pedido.
          </Text>
        ) : null}
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
  codeInput: { fontSize: 28, letterSpacing: 8, textAlign: 'center', fontWeight: '700' },
});
