import { useEffect, useRef, type ReactNode } from 'react';

/**
 * FOLHA INFERIOR (bottom sheet).
 *
 * Escolher opções de um produto sem sair da lista é o que separa a sensação de
 * app da sensação de site: navegar para outra página perde o lugar da rolagem e
 * custa uma volta inteira para desistir.
 *
 * O que ela precisa acertar para não virar uma armadilha de acessibilidade:
 *  - devolver o foco a quem a abriu ao fechar;
 *  - prender o foco dentro enquanto está aberta (Tab não escapa por trás);
 *  - fechar no Esc e no toque fora;
 *  - travar a rolagem do fundo, senão o dedo rola a página em vez do conteúdo.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Foco no painel para que leitor de tela anuncie o título ao abrir.
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreFocusTo.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sheet" role="presentation">
      <button
        type="button"
        className="sheet__scrim"
        aria-label="Fechar"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {/* Puxador: sinaliza "isto desliza" antes de qualquer instrução. */}
        <div className="sheet__grip" aria-hidden="true" />

        <div className="sheet__head">
          <h2>{title}</h2>
          <button
            type="button"
            className="sheet__close"
            aria-label="Fechar"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="sheet__body">{children}</div>

        {footer ? <div className="sheet__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
