import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, EmptyState, Touchable, spacing, useResponsive, useTheme } from '@plataforma/ui';
import { SETTINGS_SECTIONS } from '../navigation.js';
import { useSession } from '../session.js';
import type { ScreenProps } from '../navigation.js';

/**
 * ÁREA ADMINISTRATIVA — item 9.
 *
 * As 14 seções pedidas, cada uma mostrada SE E SOMENTE SE o `profile.permissions`
 * atual contém a permissão dona daquela área. A lista some e reaparece
 * conforme o papel do usuário — não existe seção "cinza, mas visível": um
 * item que o usuário não pode tocar não deveria nem ocupar espaço na tela.
 *
 * Repetindo o que vale para o app inteiro: esconder aqui é UX, não segurança.
 * Quem decide de verdade é o servidor, a cada requisição.
 */
export function SettingsScreen({ navigation }: ScreenProps<'Settings'>) {
  const theme = useTheme();
  const { gutter, isTablet } = useResponsive();
  const { profile } = useSession();

  const visible = useMemo(
    () => SETTINGS_SECTIONS.filter((s) => profile?.permissions.includes(s.permission)),
    [profile],
  );

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={{ padding: gutter, paddingBottom: spacing.xxxl }}>
        <Text style={[theme.font('caption'), { color: theme.mutedText, paddingBottom: spacing.md }]}>
          Áreas visíveis conforme o seu papel em {profile?.roles.join(', ') ?? '—'}.
        </Text>

        {visible.length === 0 ? (
          <EmptyState
            icon="🔒"
            title="Nenhuma configuração disponível"
            description="Seu perfil não tem acesso às áreas administrativas."
          />
        ) : (
          <View style={[styles.grid, isTablet && styles.gridTablet]}>
            {visible.map((section) => (
              <View key={section.key} style={isTablet ? styles.tileTablet : styles.tile}>
                <Touchable
                  onPress={() => {
                    if (section.route) navigation.navigate(section.route as 'Inventory');
                  }}
                  disabled={!section.route}
                  accessibilityLabel={section.label}
                  accessibilityHint={section.description}
                >
                  <Card>
                    <Text style={styles.icon}>{section.icon}</Text>
                    <Text style={theme.font('subheading')}>{section.label}</Text>
                    <Text numberOfLines={2} style={[theme.font('caption'), { color: theme.mutedText }]}>
                      {section.description}
                    </Text>
                    {!section.route ? (
                      <Text style={[theme.font('micro'), { color: theme.primary, paddingTop: spacing.xs }]}>
                        EM BREVE
                      </Text>
                    ) : null}
                  </Card>
                </Touchable>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  grid: { gap: spacing.md },
  gridTablet: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: {},
  tileTablet: { width: '48%' },
  icon: { fontSize: 26, paddingBottom: spacing.xs },
});
