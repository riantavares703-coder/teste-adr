import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ShareLink } from '@plataforma/client';
import { AsyncBoundary, Button, Notice } from '@plataforma/ui-web';
import { useSession } from '../session';

/**
 * COMPARTILHAR O CARDÁPIO.
 *
 * O QR code que vai para a mesa, o balcão ou o grupo do WhatsApp. O endereço
 * vem do SERVIDOR (`/share-link`) e não de `window.location`: esta página está
 * aberta em `localhost`, e um QR code com "localhost" levaria cada cliente ao
 * próprio telefone.
 */
export function SharePage() {
  const { api, branch } = useSession();

  const [link, setLink] = useState<ShareLink | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resolved = await api.getShareLink(branch.id);
      setLink(resolved);
      // Gerado no navegador: nenhuma imagem sai da máquina do restaurante, e
      // funciona sem internet.
      setQr(
        await QRCode.toDataURL(resolved.menuUrl, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: 'M',
        }),
      );
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, branch.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.menuUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Sem permissão de área de transferência: o endereço está visível na
      // tela e pode ser copiado à mão.
    }
  }

  return (
    <section>
      <div className="ui-section-header">
        <h2>Cardápio para os clientes</h2>
      </div>

      <AsyncBoundary loading={loading} error={error} onRetry={() => void load()}>
        {link ? (
          <div className="share">
            <div className="ui-card share__qr">
              {qr ? <img src={qr} alt={`QR code do cardápio de ${branch.name}`} /> : null}
              <p>Aponte a câmera do celular</p>
            </div>

            <div className="ui-card share__link">
              <h3>Endereço do cardápio</h3>
              <code>{link.menuUrl}</code>

              <div className="share__actions">
                <Button onClick={() => void copy()}>
                  {copied ? 'Copiado!' : 'Copiar endereço'}
                </Button>
                <a
                  className="ui-btn ui-btn--secondary"
                  href={link.menuUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir
                </a>
                {/*
                 * wa.me abre o WhatsApp com o texto pronto para escolher o
                 * contato ou grupo — o link em si continua sendo o mesmo
                 * endereço de rede local, então só chega a quem já está no
                 * Wi-Fi da loja (aviso logo abaixo).
                 */}
                <a
                  className="ui-btn ui-btn--secondary"
                  href={`https://wa.me/?text=${encodeURIComponent(`Confira o cardápio da ${branch.name}: ${link.menuUrl}`)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Compartilhar no WhatsApp
                </a>
              </div>

              {link.reachableFromPhones ? (
                <Notice tone="info" title="Como usar">
                  Imprima o QR code e deixe nas mesas ou no balcão. O celular do
                  cliente precisa estar no mesmo Wi-Fi da loja.
                </Notice>
              ) : (
                <Notice tone="warning" title="Só funciona neste computador">
                  Não foi possível descobrir o endereço desta máquina na rede.
                  Os clientes não vão conseguir abrir o cardápio pelo celular
                  até que este computador esteja conectado à rede da loja.
                </Notice>
              )}
            </div>
          </div>
        ) : null}
      </AsyncBoundary>
    </section>
  );
}
