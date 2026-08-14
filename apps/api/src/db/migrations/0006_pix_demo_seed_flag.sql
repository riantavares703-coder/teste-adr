-- O seed de demonstração grava uma chave Pix de mentira (demo@restaurante.local)
-- para o restaurante nascer com um pagamento "funcionando" na tela. O problema:
-- nada distinguia essa chave de mentira de uma chave real cadastrada pelo
-- lojista — se a loja nunca trocasse a chave, o cliente recebia um QR Code
-- Pix válido no formato, mas apontando para uma chave que não existe no banco
-- nenhum. Sem aviso, sem erro: o pagamento simplesmente não tinha para onde ir.
ALTER TABLE pix_settings ADD COLUMN is_demo_seed boolean NOT NULL DEFAULT false;

-- Backfill: instalações que já rodaram o seed antes desta coluna existir ficam
-- com is_demo_seed = false por padrão, ou seja, sem a proteção. Identificamos
-- a linha de demonstração pelos quatro campos fixos que só ela tem — o
-- seed nunca muda esses valores, e uma chave real do lojista colidir nos
-- quatro ao mesmo tempo é praticamente impossível.
UPDATE pix_settings
SET is_demo_seed = true
WHERE key_type = 'EMAIL'
  AND key_last4 = 'ocal'
  AND merchant_name = 'RESTAURANTE DEMO'
  AND merchant_city = 'SAO PAULO';
