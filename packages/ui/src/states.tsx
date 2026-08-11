import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError } from '@plataforma/client';
import { Button } from './components.js';
import { Pulse } from './motion.js';
import { radius, spacing, useTheme, type AppTheme } from './theme.js';

/**
 * ESTADOS DA INTERFACE (item 12).
 *
 * "Não deixar telas quebradas ou vazias sem explicação."
 *
 * Cada estado é um componente com nome próprio, e a tela escolhe entre eles
 * através de `<AsyncBoundary>`. O motivo de centralizar: quando cada tela
 * inventa o próprio "carregando…", três coisas acontecem — a mensagem de erro
 * vaza detalhe interno numa delas, o estado offline é esquecido em outra, e a
 * sessão expirada vira um 401 mudo na terceira.
 */

// ---------------------------------------------------------------------------
// Tradução de erro — a fronteira onde detalhe interno PARA
// ---------------------------------------------------------------------------

/**
 * Mensagens amigáveis por código de erro do servidor.
 *
 * O item 10 é explícito: "SQL constraint violation" e "database connection
 * failed" não podem chegar ao usuário.
 *
 * O backend já devolve RFC 9457 com códigos estáveis, então a tradução é por
 * CÓDIGO — e a `title` do servidor só é usada quando o código é conhecido.
 * Erro desconhecido cai numa mensagem genérica: preferimos ser vagos a
 * vazar o nome de uma constraint.
 */
const FRIENDLY: Record<string, string> = {
  PRODUTO_INDISPONIVEL: 'Este item acabou de esgotar. Atualize o cardápio para ver o que há.',
  ESTOQUE_INSUFICIENTE: 'Não há quantidade suficiente desse item no momento.',
  PEDIDO_NAO_ENCONTRADO: 'Não encontramos este pedido.',
  UNIDADE_NAO_ENCONTRADA: 'Não encontramos este estabelecimento.',
  FRANQUIA_NAO_ENCONTRADA: 'Não encontramos este estabelecimento.',
  VALOR_DIVERGENTE: 'Os preços mudaram enquanto você montava o pedido. Confira o novo total.',
  PEDIDO_MINIMO: 'O valor do pedido está abaixo do mínimo desta loja.',
  TRANSICAO_INVALIDA: 'Este pedido não pode ir para esse status agora.',
  PAGAMENTO_NAO_CONFIRMADO: 'O pagamento ainda não foi confirmado.',
  FORA_DA_AREA: 'Esse endereço está fora da área de entrega desta unidade.',
  APARENCIA_INVALIDA: 'Revise as cores e a fonte: alguma combinação não ficaria legível.',
  MUITAS_TENTATIVAS: 'Muitas tentativas. Aguarde um momento e tente de novo.',
  CREDENCIAIS_INVALIDAS: 'E-mail, organização ou senha incorretos.',
  PROIBIDO: 'Seu perfil não tem permissão para esta ação.',
  PERIODO_INVALIDO: 'Escolha um período válido.',
};

const GENERIC_BY_STATUS: Record<number, string> = {
  400: 'Alguns dados não foram aceitos. Revise e tente de novo.',
  401: 'Sua sessão expirou. Entre novamente.',
  403: 'Seu perfil não tem permissão para esta ação.',
  404: 'Não encontramos o que você procurou.',
  409: 'Esta informação mudou enquanto você trabalhava. Atualize a tela.',
  413: 'O arquivo é grande demais.',
  422: 'Alguns dados não foram aceitos. Revise e tente de novo.',
  429: 'Muitas tentativas. Aguarde um momento e tente de novo.',
};

/**
 * Converte qualquer erro numa mensagem exibível.
 *
 * Erro que não é `ApiError` (falha de rede, exceção de runtime, JSON inválido)
 * NUNCA tem a mensagem repassada: `error.message` pode conter host interno,
 * caminho de arquivo ou trecho de stack. Vira "não foi possível conectar".
 */
export function friendlyMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const byCode = FRIENDLY[error.code];
    if (byCode) return byCode;
    if (error.status >= 500) {
      return 'Tivemos um problema por aqui. Já estamos sabendo — tente de novo em instantes.';
    }
    return GENERIC_BY_STATUS[error.status] ?? 'Não foi possível concluir a operação.';
  }
  return 'Não foi possível conectar. Verifique sua internet e tente de novo.';
}

/** Classifica o erro no estado de tela correspondente. */
export type AsyncState = 'LOADING' | 'ERROR' | 'OFFLINE' | 'SESSION_EXPIRED' | 'FORBIDDEN' | 'READY';

export function stateForError(error: unknown): Exclude<AsyncState, 'LOADING' | 'READY'> {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'SESSION_EXPIRED';
    if (error.status === 403) return 'FORBIDDEN';
    return 'ERROR';
  }
  // Falha de fetch sem resposta HTTP: para o usuário, isso é "sem conexão".
  return 'OFFLINE';
}

// ---------------------------------------------------------------------------
// Componentes de estado
// ---------------------------------------------------------------------------

function StateShell({
  icon,
  title,
  description,
  action,
  tone,
}: {
  icon: string;
  title: string;
  description?: string;
  action?: { label: string; onPress: () => void };
  tone?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.shell}>
      <View
        style={[
          styles.iconCircle,
          { backgroundColor: tone ?? theme.primarySoft },
        ]}
      >
        <Text style={styles.icon}>{icon}</Text>
      </View>
      <Text style={[theme.font('heading'), styles.centered]}>{title}</Text>
      {description ? (
        <Text style={[theme.font('body'), styles.centered, { color: theme.mutedText }]}>
          {description}
        </Text>
      ) : null}
      {action ? (
        <View style={styles.action}>
          <Button label={action.label} onPress={action.onPress} variant="secondary" />
        </View>
      ) : null}
    </View>
  );
}

export function LoadingState({ label = 'Carregando…' }: { label?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.shell} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator size="large" color={theme.primary} />
      <Text style={[theme.font('caption'), styles.centered, { color: theme.mutedText }]}>
        {label}
      </Text>
    </View>
  );
}

export function EmptyState({
  title,
  description,
  icon = '🍽️',
  action,
}: {
  title: string;
  description?: string;
  icon?: string;
  action?: { label: string; onPress: () => void };
}) {
  return <StateShell icon={icon} title={title} description={description} action={action} />;
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <StateShell
      icon="⚠️"
      title="Algo deu errado"
      description={friendlyMessage(error)}
      action={onRetry ? { label: 'Tentar de novo', onPress: onRetry } : undefined}
    />
  );
}

export function OfflineState({ onRetry }: { onRetry?: () => void }) {
  return (
    <StateShell
      icon="📡"
      title="Sem conexão"
      description="Não conseguimos falar com o servidor. Verifique sua internet."
      action={onRetry ? { label: 'Tentar de novo', onPress: onRetry } : undefined}
    />
  );
}

export function SessionExpiredState({ onLogin }: { onLogin?: () => void }) {
  return (
    <StateShell
      icon="🔒"
      title="Sessão expirada"
      description="Por segurança, sua sessão foi encerrada. Entre novamente para continuar."
      action={onLogin ? { label: 'Entrar', onPress: onLogin } : undefined}
    />
  );
}

export function PermissionDeniedState({ onBack }: { onBack?: () => void }) {
  return (
    <StateShell
      icon="🚫"
      title="Acesso não permitido"
      // Deliberadamente não dizemos QUAL permissão falta nem se o recurso
      // existe: isso ajudaria a mapear o sistema por tentativa e erro.
      description="Seu perfil não tem acesso a esta área. Fale com o responsável pela sua unidade."
      action={onBack ? { label: 'Voltar', onPress: onBack } : undefined}
    />
  );
}

export function SuccessState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: { label: string; onPress: () => void };
}) {
  return <StateShell icon="✅" title={title} description={description} action={action} tone="#e6f6ed" />;
}

// ---------------------------------------------------------------------------
// Esqueletos
// ---------------------------------------------------------------------------

/**
 * Esqueleto no lugar de um spinner de tela cheia.
 *
 * A diferença não é enfeite: o esqueleto mostra a FORMA do que vem, então a
 * tela não "pula" quando o conteúdo chega. É o que separa um carregamento que
 * parece rápido de um que parece travado.
 */
export function Skeleton({
  height = 16,
  width = '100%',
  rounded = radius.sm,
}: {
  height?: number;
  width?: number | `${number}%`;
  rounded?: number;
}) {
  const theme = useTheme();
  return (
    <Pulse style={{ height, width, borderRadius: rounded, backgroundColor: theme.subtle }} />
  );
}

export function ProductCardSkeleton({ imageHeight = 160 }: { imageHeight?: number }) {
  const theme = useTheme();
  return (
    <View style={[styles.skeletonCard, { backgroundColor: theme.card }]}>
      <Skeleton height={imageHeight} rounded={radius.md} />
      <View style={{ gap: spacing.sm, paddingTop: spacing.md }}>
        <Skeleton height={18} width="70%" />
        <Skeleton height={14} width="90%" />
        <Skeleton height={20} width="40%" />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Fronteira assíncrona
// ---------------------------------------------------------------------------

/**
 * Envolve o conteúdo de uma tela e resolve TODOS os estados de uma vez.
 *
 * O ganho real: é impossível uma tela esquecer o estado offline ou o de sessão
 * expirada, porque ela não decide quais estados tratar — ela só informa o que
 * está acontecendo.
 */
export function AsyncBoundary({
  loading,
  error,
  isEmpty,
  empty,
  onRetry,
  onSessionExpired,
  loadingLabel,
  skeleton,
  children,
}: {
  loading: boolean;
  error: unknown;
  isEmpty?: boolean;
  empty?: React.ReactNode;
  onRetry?: () => void;
  onSessionExpired?: () => void;
  loadingLabel?: string;
  skeleton?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (loading) {
    return skeleton ? <>{skeleton}</> : <LoadingState label={loadingLabel} />;
  }

  if (error) {
    switch (stateForError(error)) {
      case 'SESSION_EXPIRED':
        return <SessionExpiredState onLogin={onSessionExpired} />;
      case 'FORBIDDEN':
        return <PermissionDeniedState onBack={onRetry} />;
      case 'OFFLINE':
        return <OfflineState onRetry={onRetry} />;
      default:
        return <ErrorState error={error} onRetry={onRetry} />;
    }
  }

  if (isEmpty) {
    return <>{empty ?? <EmptyState title="Nada por aqui ainda" />}</>;
  }

  return <>{children}</>;
}

/** Tela de estado que precisa rolar (teclado aberto em aparelho pequeno). */
export function ScrollableState({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: spacing.md,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { fontSize: 30 },
  centered: { textAlign: 'center' },
  action: { paddingTop: spacing.sm, minWidth: 180 },
  skeletonCard: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
});

/** Reexporta o tipo de tema para telas que precisem tipar helpers locais. */
export type { AppTheme };
