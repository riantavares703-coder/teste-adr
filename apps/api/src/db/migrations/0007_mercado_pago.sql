-- Integração Pix com o Mercado Pago (cobrança dinâmica com o valor exato do pedido).
-- O access token é segredo da loja: gravado cifrado (mesmo envelope da chave Pix),
-- nunca devolvido pela API. Só os 4 últimos caracteres ficam em claro, para o
-- operador reconhecer qual credencial está ativa.
ALTER TABLE pix_settings
  ADD COLUMN mp_access_token_encrypted bytea,
  ADD COLUMN mp_token_last4 text;

-- A conciliação automática consulta só pagamentos Mercado Pago em aberto.
CREATE INDEX payments_mp_open_idx
  ON payments (created_at)
  WHERE provider = 'MERCADO_PAGO' AND status = 'AWAITING_CONFIRMATION';
