-- Endereço público do cardápio (ex.: https://cardapio.minhaloja.com.br), definido
-- pelo dono da unidade. É ele que vai no link e no QR code: um endereço de rede
-- local (192.168.x.x) só funciona dentro do Wi-Fi da loja.
--
-- Só HTTPS e só a origem (sem caminho): por esse endereço passam pedidos e
-- pagamentos, e o caminho é montado pelo servidor. A aplicação valida antes de
-- gravar; esta restrição é a segunda barreira.
ALTER TABLE store_settings
  ADD COLUMN public_base_url text,
  ADD CONSTRAINT store_settings_public_base_url_https
    CHECK (public_base_url IS NULL OR public_base_url ~ '^https://[^/?#@[:space:]]+$');
