/**
 * Copia texto para a área de transferência, também em HTTP na rede local.
 *
 * `navigator.clipboard` só existe em contexto seguro (HTTPS ou localhost). O
 * cardápio e o painel muitas vezes abrem por http://192.168.x.x, onde ele é
 * `undefined` — por isso o método legado (seleção + execCommand) como reserva.
 * Devolve `false` quando nenhum método funcionou, para a tela avisar em vez de
 * fingir que copiou. Se `visible` for passado, o texto é selecionado nele para
 * o usuário copiar à mão.
 */
export async function copyText(text: string, visible?: HTMLElement | null): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // cai para o método legado
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);

  if (!ok && visible) {
    const range = document.createRange();
    range.selectNodeContents(visible);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return ok;
}
