import { useState, type FormEvent } from 'react';
import { Button, Field, Notice, friendlyMessage } from '@plataforma/ui-web';
import { useSession } from '../session';

const MIN_LENGTH = 12;

/**
 * MINHA CONTA — troca de senha.
 *
 * O servidor exige a senha atual, encerra TODAS as sessões anteriores (de
 * qualquer aparelho) e devolve uma nova, que o cliente da API já guarda: quem
 * troca a senha continua conectado neste aparelho.
 */
export function AccountPage() {
  const { api, profile } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < MIN_LENGTH;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(false);
    if (next.length < MIN_LENGTH) return setError(`A nova senha precisa ter ao menos ${MIN_LENGTH} caracteres.`);
    if (next !== confirm) return setError('A confirmação não é igual à nova senha.');

    setSaving(true);
    setError(null);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (e) {
      setError(friendlyMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="account">
      <div className="ui-section-header">
        <h2>Minha conta</h2>
      </div>

      <div className="ui-card">
        <h3>Trocar senha</h3>
        <p className="form__hint">
          Conectado como <strong>{profile.fullName}</strong>. Ao trocar, os outros aparelhos conectados com esta conta são
          desconectados.
        </p>

        <form onSubmit={(e) => void submit(e)}>
          <Field
            label="Senha atual"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Field
            label="Nova senha"
            type="password"
            autoComplete="new-password"
            value={next}
            hint={`Pelo menos ${MIN_LENGTH} caracteres. Uma frase longa é melhor que uma palavra complicada.`}
            error={tooShort ? `Faltam ${MIN_LENGTH - next.length} caracteres.` : undefined}
            onChange={(e) => setNext(e.target.value)}
          />
          <Field
            label="Repita a nova senha"
            type="password"
            autoComplete="new-password"
            value={confirm}
            error={mismatch ? 'Não é igual à nova senha.' : undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />

          {error ? <Notice tone="danger">{error}</Notice> : null}
          {done ? (
            <Notice tone="success" title="Senha alterada">
              Você continua conectado neste aparelho. Os outros foram desconectados.
            </Notice>
          ) : null}

          <div className="form__footer">
            <Button type="submit" loading={saving} disabled={!current || !next || !confirm}>
              Trocar senha
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
