import { useState, type FormEvent } from 'react';
import { Button, Field, Notice, friendlyMessage } from '@plataforma/ui-web';
import { api, rememberOrganization } from '../session';

/**
 * Entrada do operador.
 *
 * A organização é campo próprio, e não inferida do e-mail: o mesmo e-mail pode
 * existir em franquias diferentes, e adivinhar qual é abriria um caminho para
 * descobrir onde uma pessoa trabalha.
 */
export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [organizationSlug, setOrganizationSlug] = useState('demo');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.loginStaff({ organizationSlug: organizationSlug.trim(), email, password });
      rememberOrganization(organizationSlug.trim());
      onSignedIn();
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login">
      <form className="ui-card login__card" onSubmit={submit}>
        <h1>Painel da loja</h1>

        <Field
          label="Loja"
          value={organizationSlug}
          autoCapitalize="none"
          onChange={(e) => setOrganizationSlug(e.target.value)}
        />
        <Field
          label="E-mail"
          type="email"
          value={email}
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Senha"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Button full type="submit" loading={submitting}>
          Entrar
        </Button>
      </form>
    </main>
  );
}
