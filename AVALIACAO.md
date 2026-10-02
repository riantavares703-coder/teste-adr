# Avaliação do app — Plataforma de Pedidos

Última revisão: 2026-10-02. Este documento separa **o que foi verificado** do que **não foi**.

## Verificado (rodando o app de verdade)

- Sobe com `pnpm start`: banco, migrações (agora 7), seed e API.
- API: login do operador, `/auth/me`, filiais e cardápio público respondem.
- Telas (Chromium): login do painel, página de configurações, cardápio do cliente,
  carrinho, checkout e tela de pagamento Pix renderizam e funcionam.
- Testes automatizados: domínio (144) + API (186) passando.

## Problemas encontrados e corrigidos

1. **Código Pix inválido.** A chave era embutida no BR Code como digitada
   (`(11) 99999-1234`); os bancos exigem formato canônico (`+5511999991234`, CPF/CNPJ só
   dígitos, e-mail minúsculo). Agora a chave é normalizada e validada (dígitos
   verificadores de CPF/CNPJ) ao salvar e ao gerar a cobrança.
2. **Pedido pago podia ser expirado.** O job de expiração cancelava pedidos `PENDING`
   mesmo com pagamento `CONFIRMED`. Agora ignora pedidos já pagos.

## Nova funcionalidade: Pix pelo Mercado Pago

Com o access token configurado em *Horário > Chave Pix*:

- cada pedido cria uma cobrança Pix dinâmica no Mercado Pago com o **valor exato do total**;
- a API consulta o MP a cada 5 s e **confirma sozinha** quando aprovado, conferindo valor e
  referência do pedido (divergência não confirma e gera auditoria);
- se o MP estiver fora do ar, o pedido cai para o Pix estático com a chave da loja
  (confirmação manual) em vez de falhar.

O token é validado no MP ao salvar, guardado cifrado e nunca devolvido pela API.

### Não verificado

- **Nunca foi executado contra o Mercado Pago real.** O ambiente de desenvolvimento
  bloqueia `api.mercadopago.com`; a integração foi testada contra um MP simulado que segue
  o contrato documentado (`/v1/payments`, `/users/me`). Faça um pedido de teste com
  credenciais reais antes de usar em produção.
- Dois detalhes do contrato são suposições a confirmar no primeiro teste real: o e-mail
  genérico do pagador (`cliente.<n>@pedido.com.br`) e a ausência de `date_of_expiration`.
- Pix pago depois de o pedido expirar (15 min) cai na conta da loja sem pedido associado:
  exige estorno manual.
- A confirmação é por consulta, não por webhook, porque o sistema roda na rede local da
  loja. Exige internet de saída no computador da loja.
- Não foram testados: app Android, entrega, WhatsApp, upload de imagens, relatórios.
