import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import type { ShareCheck, ShareCheckFailure, ShareLink, ShareReach } from '@plataforma/client';
import {
  AsyncBoundary,
  Button,
  Field,
  Notice,
  copyText,
  friendlyMessage,
} from '@plataforma/ui-web';
import { useSession } from '../session';

/**
 * COMPARTILHAR O CARDÁPIO.
 *
 * O QR code que vai para a mesa, o balcão, o grupo do WhatsApp ou o Instagram.
 * A pergunta que importa não é "qual é o endereço", e sim ATÉ ONDE ELE ALCANÇA:
 * um endereço de rede local (192.168.x.x) só abre para quem está no Wi-Fi da
 * loja — um cliente em casa ou no 4G não chega. Por isso a tela diz o alcance do
 * link com todas as letras e leva o dono ao endereço público.
 *
 * O endereço vem do SERVIDOR (`/share-link`) e não de `window.location`: o
 * servidor sabe a variável de ambiente, o IP da máquina e o endereço cadastrado.
 */

const REACH: Record<ShareReach, { tone: 'success' | 'warning' | 'danger'; title: string; text: string }> = {
  public: {
    tone: 'success',
    title: 'Funciona de qualquer lugar',
    text: 'Seus clientes abrem este link em casa, no 4G ou no Wi-Fi da loja.',
  },
  lan: {
    tone: 'warning',
    title: 'Só funciona no Wi-Fi da loja',
    text: 'Este endereço só abre para quem está conectado ao mesmo Wi-Fi. Cliente em casa ou no 4G não consegue abrir. Cadastre o endereço público logo abaixo.',
  },
  local: {
    tone: 'danger',
    title: 'Só funciona neste computador',
    text: 'Nem o celular dos clientes dentro da loja consegue abrir este endereço. Conecte o computador à rede da loja ou cadastre o endereço público logo abaixo.',
  },
};

const CHECK_REASON: Record<ShareCheckFailure, string> = {
  NOT_PUBLIC: 'Esse endereço só funciona dentro da sua rede.',
  UNREACHABLE:
    'Não conseguimos abrir esse endereço a partir daqui. Confira se o endereço está certo e se o sistema está no ar.',
  TIMEOUT: 'O endereço demorou demais para responder.',
  BLOCKED_ADDRESS: 'Esse endereço aponta para dentro de uma rede, e não para a internet.',
  TLS: 'O certificado de segurança (https) desse endereço não é válido.',
  REDIRECT: 'Esse endereço redireciona para outro. Use o endereço final, o de depois do redirecionamento.',
  HTTP_STATUS: 'O endereço respondeu com erro.',
  INVALID_RESPONSE: 'O endereço respondeu, mas não parece ser este sistema.',
  NOT_THIS_SYSTEM: 'O endereço abre outro sistema (ou outra loja), e não o seu cardápio.',
};

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok' }
  | { status: 'failed'; reason: ShareCheckFailure; httpStatus?: number };

export function SharePage() {
  const { api, branch, can } = useSession();
  const canEdit = can('settings:update');

  const [link, setLink] = useState<ShareLink | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [posterQr, setPosterQr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const codeRef = useRef<HTMLElement>(null);

  const runCheck = useCallback(async () => {
    setCheck({ status: 'checking' });
    try {
      const result: ShareCheck = await api.checkShareLink(branch.id);
      setCheck(
        result.ok
          ? { status: 'ok' }
          : { status: 'failed', reason: result.reason ?? 'UNREACHABLE', httpStatus: result.httpStatus },
      );
    } catch {
      setCheck({ status: 'failed', reason: 'UNREACHABLE' });
    }
  }, [api, branch.id]);

  const applyLink = useCallback(
    async (resolved: ShareLink) => {
      setLink(resolved);
      setDraft(resolved.publicBaseUrl ?? '');
      // Gerado no navegador: nenhuma imagem sai da máquina do restaurante, e
      // funciona sem internet.
      setQr(await QRCode.toDataURL(resolved.menuUrl, { width: 320, margin: 1, errorCorrectionLevel: 'M' }));
      setPosterQr(await QRCode.toDataURL(resolved.menuUrl, { width: 900, margin: 1, errorCorrectionLevel: 'M' }));
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resolved = await api.getShareLink(branch.id);
      await applyLink(resolved);
      setError(null);
      // Só vale testar quando o endereço é público e NÃO é o próprio endereço do
      // painel (esse já está provado: é por onde esta tela foi aberta).
      if (canEdit && resolved.reach === 'public' && resolved.source !== 'request') {
        void runCheck();
      } else {
        setCheck({ status: 'idle' });
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, branch.id, applyLink, canEdit, runCheck]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy() {
    if (!link) return;
    const ok = await copyText(link.menuUrl, codeRef.current);
    setCopied(ok ? 'ok' : 'fail');
    setTimeout(() => setCopied(null), 3000);
  }

  async function share() {
    if (!link) return;
    try {
      await navigator.share({
        title: `Cardápio — ${branch.name}`,
        text: `Confira o cardápio da ${branch.name} e peça pelo celular:`,
        url: link.menuUrl,
      });
    } catch {
      // Cancelou a folha de compartilhamento: nada a fazer.
    }
  }

  function downloadQr() {
    if (!posterQr || !link) return;
    const a = document.createElement('a');
    a.href = posterQr;
    a.download = `qr-cardapio-${link.branchSlug}.png`;
    a.click();
  }

  async function savePublicUrl(next: string | null) {
    setSaving(true);
    setSaveError(null);
    try {
      const resolved = await api.setPublicBaseUrl(branch.id, next);
      await applyLink(resolved);
      if (resolved.reach === 'public' && resolved.source !== 'request') void runCheck();
      else setCheck({ status: 'idle' });
    } catch (e) {
      setSaveError(friendlyMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const reach = link ? REACH[link.reach] : null;
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <section>
      <div className="ui-section-header">
        <h2>Cardápio para os clientes</h2>
      </div>

      <AsyncBoundary loading={loading} error={error} onRetry={() => void load()}>
        {link && reach ? (
          <>
            <Notice tone={reach.tone} title={reach.title}>
              {reach.text}
            </Notice>

            {link.warnings.includes('DEFAULT_ADMIN_PASSWORD') ? (
              <Notice tone="danger" title="Troque a senha antes de divulgar este link">
                A senha da conta de demonstração (admin@demo.local) está escrita no manual. Com o cardápio na
                internet, qualquer pessoa poderia entrar no painel e até trocar a chave Pix da loja.{' '}
                <Link to="/conta">Trocar a senha agora</Link>
              </Notice>
            ) : null}

            {link.warnings.includes('INSECURE_HTTP') ? (
              <Notice tone="warning" title="Endereço sem criptografia">
                Este endereço começa com http://. Pedidos e pagamentos passariam sem proteção pela internet. Use
                um endereço https://.
              </Notice>
            ) : null}

            <div className="share">
              <div className="ui-card share__qr">
                <div className="share__qrbox">
                  {qr ? <img src={qr} alt={`QR code do cardápio de ${branch.name}`} /> : null}
                  {link.reach !== 'public' ? <span className="share__badge">Só no Wi-Fi da loja</span> : null}
                </div>
                <p>Aponte a câmera do celular</p>
                <div className="share__actions share__actions--center">
                  <Button variant="secondary" onClick={downloadQr}>
                    Baixar QR code
                  </Button>
                  <Button variant="secondary" onClick={() => window.print()}>
                    Imprimir cartaz
                  </Button>
                </div>
              </div>

              <div className="ui-card share__link">
                <h3>Endereço do cardápio</h3>
                <code ref={codeRef}>{link.menuUrl}</code>

                <div className="share__actions">
                  <Button onClick={() => void copy()}>
                    {copied === 'ok' ? 'Copiado!' : 'Copiar endereço'}
                  </Button>
                  {canNativeShare ? (
                    <Button variant="secondary" onClick={() => void share()}>
                      Compartilhar…
                    </Button>
                  ) : null}
                  <a
                    className="ui-btn ui-btn--secondary"
                    href={`https://wa.me/?text=${encodeURIComponent(`Confira o cardápio da ${branch.name} e peça pelo celular: ${link.menuUrl}`)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    WhatsApp
                  </a>
                  <a className="ui-btn ui-btn--secondary" href={link.menuUrl} target="_blank" rel="noreferrer">
                    Abrir
                  </a>
                </div>
                {copied === 'fail' ? (
                  <small role="alert">Não foi possível copiar automaticamente. O endereço acima está selecionado: copie com Ctrl+C.</small>
                ) : null}

                {link.reach === 'public' && link.source === 'request' ? (
                  <small className="share__verdict">Você está acessando o painel por este mesmo endereço.</small>
                ) : null}
                {check.status === 'checking' ? (
                  <small className="share__verdict" role="status">
                    Verificando se o endereço abre pela internet…
                  </small>
                ) : null}
                {check.status === 'ok' ? (
                  <small className="share__verdict share__verdict--ok" role="status">
                    ✓ Verificado: este endereço abre o seu cardápio pela internet.
                  </small>
                ) : null}
                {check.status === 'failed' ? (
                  <small className="share__verdict share__verdict--fail" role="alert">
                    Não conseguimos confirmar: {CHECK_REASON[check.reason]}
                    {check.httpStatus ? ` (código ${check.httpStatus})` : ''} Teste também abrindo o link pelo 4G do seu
                    celular — alguns roteadores não deixam abrir o próprio endereço público de dentro da rede.
                  </small>
                ) : null}
              </div>
            </div>

            <div className="ui-card share__public">
              <h3>Endereço público (para clientes em casa)</h3>
              <p className="form__hint">
                O link acima só alcança clientes de fora quando usa um endereço da internet. Informe o endereço onde o
                seu sistema está publicado, por exemplo <strong>https://cardapio.minhaloja.com.br</strong>. Nós
                montamos o link completo e o QR code a partir dele.
              </p>

              {canEdit ? (
                <>
                  <Field
                    label="Endereço do site"
                    value={draft}
                    placeholder="https://cardapio.minhaloja.com.br"
                    inputMode="url"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  {saveError ? (
                    <Notice tone="danger">
                      {saveError}
                      {saveError.includes('Minha conta') ? (
                        <>
                          {' '}
                          <Link to="/conta">Trocar a senha</Link>
                        </>
                      ) : null}
                    </Notice>
                  ) : null}
                  <div className="share__actions">
                    <Button loading={saving} onClick={() => void savePublicUrl(draft.trim() || null)}>
                      Salvar e verificar
                    </Button>
                    {link.publicBaseUrl ? (
                      <Button variant="ghost" disabled={saving} onClick={() => void savePublicUrl(null)}>
                        Remover endereço
                      </Button>
                    ) : null}
                    {link.reach === 'public' && link.source !== 'request' ? (
                      <Button variant="ghost" disabled={check.status === 'checking'} onClick={() => void runCheck()}>
                        Testar de novo
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <Notice tone="info">Peça a quem gerencia a loja para cadastrar o endereço público.</Notice>
              )}

              <details className="share__howto">
                <summary>Como conseguir um endereço público?</summary>
                <ol>
                  <li>
                    <strong>Colocar o sistema na internet</strong> (recomendado): hospede-o em um serviço online. Ele
                    ganha um endereço https permanente e funciona mesmo com o computador da loja desligado.
                  </li>
                  <li>
                    <strong>Túnel seguro</strong>: um programa (como o Cloudflare Tunnel) liga o computador da loja a
                    um endereço público. Funciona, mas o computador precisa ficar ligado e conectado.
                  </li>
                  <li>
                    <strong>Domínio próprio</strong>: registre um nome (ex.: cardapio.minhaloja.com.br) e aponte para
                    uma das opções acima.
                  </li>
                </ol>
                <p>Detalhes no arquivo <code>docs/PUBLICAR.md</code> que acompanha o sistema.</p>
              </details>
            </div>

            {/* Cartaz: só aparece na impressão. */}
            <div className="share__poster" aria-hidden="true">
              <h1>{branch.name}</h1>
              <p className="share__poster-lead">Peça pelo celular</p>
              {posterQr ? <img src={posterQr} alt="" /> : null}
              <p className="share__poster-cta">Aponte a câmera para o QR code</p>
              <p className="share__poster-url">{link.menuUrl}</p>
            </div>
          </>
        ) : null}
      </AsyncBoundary>
    </section>
  );
}
