import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  Field,
  Notice,
  Touchable,
  friendlyMessage,
  spacing,
  useResponsive,
  useTheme,
} from '@plataforma/ui';
import { useSession } from '../session.js';
import type { ScreenProps } from '../navigation.js';

/**
 * ENTRADA DO CLIENTE — telefone + código.
 *
 * Sem senha: o cliente não gerencia mais uma. O código chega por WhatsApp/SMS
 * e vale por poucos minutos.
 *
 * A tela nunca revela se o telefone já tem conta. "Enviamos um código" é a
 * resposta para número novo e para número conhecido — caso contrário, a tela
 * vira um oráculo para descobrir quem é cliente daquela loja.
 *
 * Sempre apresentada como MODAL sobre a tela que pediu login (Checkout,
 * Pagamento, Acompanhamento). Por isso o retorno é sempre `goBack()`: a tela
 * de baixo continua montada, com os parâmetros dela intactos — não existe
 * "para onde voltar" para decidir, e um `replace()` para uma tela que exige
 * parâmetros (`Checkout`, `Tracking`) quebraria exatamente por faltar esses
 * parâmetros.
 */
export function LoginScreen({ navigation }: ScreenProps<'Login'>) {
  const theme = useTheme();
  const { gutter } = useResponsive();
  const { api, refreshProfile } = useSession();

  const [step, setStep] = useState<'PHONE' | 'CODE'>('PHONE');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode() {
    setBusy(true);
    setError(null);
    try {
      await api.requestOtp(toE164(phone));
      setStep('CODE');
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await api.verifyOtp({
        phone: toE164(phone),
        code: code.trim(),
        fullName: fullName.trim() || undefined,
      });
      await refreshProfile();
      navigation.goBack();
    } catch (e) {
      setError(friendlyMessage(e));
      setCode('');
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
        <ScrollView contentContainerStyle={[styles.content, { padding: gutter }]}>
          <Text style={theme.font('title')}>
            {step === 'PHONE' ? 'Entrar' : 'Confirme o código'}
          </Text>
          <Text style={[theme.font('body'), { color: theme.mutedText }]}>
            {step === 'PHONE'
              ? 'Usamos seu telefone para você acompanhar o pedido.'
              : `Enviamos um código para ${phone}.`}
          </Text>

          <Card>
            {step === 'PHONE' ? (
              <Field
                label="Telefone"
                placeholder="(11) 90000-0000"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                hint="Você receberá um código de verificação."
              />
            ) : (
              <View style={{ gap: spacing.md }}>
                <Field
                  label="Código"
                  placeholder="000000"
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  maxLength={6}
                />
                <Field
                  label="Como podemos te chamar?"
                  placeholder="Seu nome"
                  value={fullName}
                  onChangeText={setFullName}
                  autoComplete="name"
                  hint="Só na primeira vez."
                />
              </View>
            )}
          </Card>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button
            label={step === 'PHONE' ? 'Receber código' : 'Confirmar'}
            loading={busy}
            disabled={step === 'PHONE' ? phone.trim().length < 10 : code.trim().length < 4}
            onPress={() => void (step === 'PHONE' ? requestCode() : verify())}
          />

          {step === 'CODE' ? (
            <Touchable
              onPress={() => {
                setStep('PHONE');
                setCode('');
                setError(null);
              }}
              accessibilityLabel="Corrigir telefone"
            >
              <Text
                style={[theme.font('caption'), { color: theme.primary, textAlign: 'center', padding: spacing.md }]}
              >
                Usar outro telefone
              </Text>
            </Touchable>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

/**
 * Normaliza para E.164.
 *
 * É conveniência de digitação, não validação: o servidor valida de novo e
 * recusa o que não for um número plausível.
 */
function toE164(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (input.trim().startsWith('+')) return `+${digits}`;
  return digits.length > 11 ? `+${digits}` : `+55${digits}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', gap: spacing.md },
});
