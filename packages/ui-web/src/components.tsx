import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { formatBRL } from '@plataforma/domain';

/**
 * Componentes compartilhados pelo painel e pelo cardápio.
 *
 * Regras que valem para todos:
 *  - cor vem de variável CSS (o tema da franquia), nunca literal;
 *  - o que é clicável tem no mínimo 44px de altura (WCAG 2.5.5);
 *  - estado (carregando, erro, vazio) é componente, não `if` espalhado.
 */

// --- Botão ------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  full?: boolean;
}

export function Button({
  variant = 'primary',
  loading = false,
  full = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      // Desabilitar enquanto carrega é o que impede o duplo-clique de virar
      // dois pedidos.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`ui-btn ui-btn--${variant} ${full ? 'ui-btn--full' : ''} ${className}`}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

// --- Superfícies ------------------------------------------------------------

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li' | 'section' | 'article';
}) {
  return <Tag className={`ui-card ${className}`}>{children}</Tag>;
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="ui-section-header">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="ui-row">
      <span className="ui-row__label">{label}</span>
      <span className="ui-row__value">{value}</span>
    </div>
  );
}

// --- Dados ------------------------------------------------------------------

/** Dinheiro sempre pelo formatador do domínio: centavos, com separador. */
export function Price({ cents, className = '' }: { cents: number; className?: string }) {
  return <span className={`ui-price ${className}`}>{formatBRL(cents)}</span>;
}

export function StatCard({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="ui-stat">
      <strong className="ui-stat__value">{value}</strong>
      <span className="ui-stat__label">{label}</span>
    </div>
  );
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>;
}

export function Notice({
  children,
  tone = 'info',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    // `role="alert"` só em erro: em avisos informativos ele interromperia o
    // leitor de tela sem motivo.
    <div className={`ui-notice ui-notice--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title ? <strong className="ui-notice__title">{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

// --- Formulário -------------------------------------------------------------

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
}

export function Field({ label, hint, error, id, ...rest }: FieldProps) {
  const inputId = id ?? `f-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className="ui-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        // Aponta para a mensagem para que o leitor de tela a anuncie junto do
        // campo, em vez de deixá-la como texto solto ao lado.
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={error ? 'ui-input ui-input--error' : 'ui-input'}
      />
      {hint ? (
        <small id={hintId} className="ui-field__hint">
          {hint}
        </small>
      ) : null}
      {error ? (
        <small id={errorId} className="ui-field__error">
          {error}
        </small>
      ) : null}
    </div>
  );
}

// --- Estados ----------------------------------------------------------------

/**
 * Esqueleto de carregamento.
 *
 * Usado sempre que a FORMA do conteúdo é conhecida de antemão. O spinner diz
 * "espere"; o esqueleto mostra o que vem e onde, e a espera parece menor sem
 * enganar ninguém — o layout final é exatamente esse.
 */
export function Skeleton({
  width,
  height = 16,
  radius,
  className = '',
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}) {
  return (
    <span
      className={`ui-skeleton ${className}`}
      aria-hidden="true"
      style={{
        display: 'block',
        width: width ?? '100%',
        height,
        borderRadius: radius,
      }}
    />
  );
}

export function LoadingState({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="ui-state" role="status">
      <span className="ui-spinner ui-spinner--lg" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({
  icon = '📭',
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-state">
      <span className="ui-state__icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="ui-state" role="alert">
      <span className="ui-state__icon" aria-hidden="true">
        ⚠️
      </span>
      <h3>Algo deu errado</h3>
      <p>{message}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Tentar de novo
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Traduz o erro do servidor para algo que o usuário final entenda.
 *
 * Nunca devolve a mensagem crua: ela pode conter nome de tabela, coluna ou
 * detalhe interno que não ajuda quem está no balcão e ainda revela estrutura.
 *
 * A distinção que importa é `status === undefined` (o fetch nem chegou a
 * completar — aí sim, "quase sempre é rede") contra "o servidor respondeu, só
 * não temos tradução para ESTE código" — os dois eram tratados como a mesma
 * coisa antes, e todo erro sem uma entrada exata em `byCode` (um carrinho
 * vazio, um pedido abaixo do mínimo, uma faixa de horário inválida — qualquer
 * 400/422 sem status explícito abaixo) caía na mensagem de rede, escondendo
 * do cliente exatamente o motivo pelo qual o pedido foi recusado.
 */
export function friendlyMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  const status = (error as { status?: number })?.status;
  const details = (error as { details?: Record<string, unknown> })?.details;

  const byCode: Record<string, string> = {
    PRODUTO_INDISPONIVEL: 'Esse item acabou de esgotar.',
    PRODUTO_SEM_ESTOQUE: 'Não há quantidade suficiente desse item.',
    PRECO_ALTERADO: 'O preço mudou. Confira o carrinho e tente de novo.',
    UNIDADE_NAO_ENCONTRADA: 'Loja não encontrada.',
    PERMISSAO_NEGADA: 'Você não tem permissão para isso.',
    CREDENCIAIS_INVALIDAS: 'E-mail ou senha incorretos.',
    LOJA_FECHADA: 'A loja está fechada no momento.',
    PIX_NAO_CONFIGURADO: 'Pix indisponível no momento. Escolha outra forma de pagamento.',
    METODO_INDISPONIVEL: 'Essa forma de pagamento não está disponível nesta loja.',
    CARRINHO_VAZIO: 'Seu carrinho está vazio.',
    CARRINHO_GRANDE: 'Carrinho com itens demais. Remova alguns e tente de novo.',
    ENTREGA_INDISPONIVEL: 'Esta loja não faz entrega.',
    RETIRADA_INDISPONIVEL: 'Esta loja não faz retirada no balcão.',
    ESCOLHA_INVALIDA: 'Uma opção escolhida não é mais válida. Confira o item e tente de novo.',
    ENDERECO_OBRIGATORIO: 'Escolha um endereço de entrega.',
    ENDERECO_NAO_ENCONTRADO: 'Endereço não encontrado.',
    FORA_DA_AREA: 'Esse endereço está fora da área de entrega da loja.',
    HORARIO_INVALIDO: 'Horário inválido.',
    PEDIDO_MINIMO:
      typeof details?.minOrderCents === 'number'
        ? `O pedido mínimo desta loja é ${formatBRL(details.minOrderCents)}.`
        : 'O pedido está abaixo do valor mínimo da loja.',
  };
  if (code && byCode[code]) return byCode[code];

  if (status !== undefined) {
    if (status === 401) return 'Sua sessão expirou. Entre de novo.';
    if (status === 403) return 'Você não tem permissão para isso.';
    if (status === 404) return 'Não encontramos o que você procurou.';
    if (status === 409) return 'Isso mudou enquanto você preenchia. Confira e tente de novo.';
    if (status >= 500) return 'O sistema falhou. Tente de novo em instantes.';
    // O servidor respondeu (400, 422, 429...) mas não é um dos casos acima
    // nem tem tradução específica em `byCode` — ainda assim NÃO é rede.
    return 'Não foi possível concluir. Confira os dados e tente de novo.';
  }

  // Só agora, sem status nenhum, é que o fetch de fato não completou.
  return 'Não foi possível conectar. Verifique a internet e tente de novo.';
}

/** Envolve conteúdo que depende de carregamento remoto. */
export function AsyncBoundary({
  loading,
  error,
  onRetry,
  isEmpty,
  empty,
  children,
}: {
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  isEmpty?: boolean;
  empty?: ReactNode;
  children: ReactNode;
}) {
  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={friendlyMessage(error)} onRetry={onRetry} />;
  if (isEmpty && empty) return <>{empty}</>;
  return <>{children}</>;
}

export { formatBRL };
