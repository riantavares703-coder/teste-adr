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
- Não foram testados: app Android, WhatsApp, upload de imagens, relatórios.

## Entrega com mapa

- Cliente: busca de endereço, mapa com pino da loja e do cliente, campos editáveis, taxa/prazo
  e pedido mínimo calculados no servidor. Loja: marca posição, raio, taxa, mínimo e prazo.
- Bug encontrado e corrigido: a CSP do servidor bloqueava a busca (Nominatim) e os blocos do
  mapa (OpenStreetMap) mesmo com internet. Agora libera só esses dois hosts.
- **Verificado com rede simulada:** o ambiente de desenvolvimento bloqueia OpenStreetMap,
  Nominatim e ViaCEP. Busca, leitura de endereço ao tocar no mapa e carga dos blocos foram
  testadas interceptando as requisições com respostas no formato real do Nominatim. Falta
  um teste num celular com internet de verdade (ex.: limites de uso do Nominatim).
- Pedido mínimo da zona é aplicado no servidor (e avisado no checkout) só para entrega.

## Interface e modo escuro

- Modo claro / escuro / automático (botão no cabeçalho; preferência salva no aparelho). O
  tema escuro é derivado da cor da marca da loja com contraste garantido por testes.
- Cardápio com espaço para foto (e miniatura + aviso de "produtos sem foto" no painel),
  cartão de pedido com ações em verbo, faturamento mais limpo, checkout de entrega em dois
  passos, "Disponível/Esgotado" e "Excluir" discreto.

## Testes de dinheiro e bugs encontrados por eles

- Propriedades aleatórias (semente fixa): total do pedido contra conta independente em
  BigInt (3000 carrinhos), valor do BR Code reconstruindo os centavos (20 mil valores), CRC
  detectando alteração do valor, exibição `formatBRL`.
- API: pagamento = total do pedido; preço imposto pelo cliente recusado; preço alterado
  depois não muda a cobrança; total desatualizado não cria nada; idempotência (inclusive 6
  envios simultâneos); confirmação simultânea; arredondamento do Mercado Pago (11 preços).
- **Bug corrigido:** confirmações manuais simultâneas passavam todas (5 de 5), gerando
  eventos e auditorias duplicados. A linha agora é travada.
- **Bug corrigido:** cancelar, recusar ou expirar um pedido não encerrava a cobrança aberta,
  então ainda dava para "confirmar" o pagamento de um pedido cancelado (e a conciliação
  automática faria isso sozinha). Agora a cobrança é cancelada junto.
- Pix pago depois do cancelamento não confirma nada: fica registrado (`payment.received_after_cancel`)
  e a cobrança ganha o aviso "estornar no Mercado Pago". Hoje o aviso aparece só no
  registro/log; não há tela para isso.

## Link público do cardápio

- **Problema:** o link/QR usava o IP da rede local; só abria no Wi-Fi da loja.
- **Agora:** a tela *Compartilhar* diz até onde o link alcança (público / só Wi-Fi da loja / só este
  computador), aceita o endereço público da loja (https, só nome de site), **verifica pelo servidor**
  que ele abre esta unidade e monta link e QR a partir dele. Também: copiar (funciona em HTTP),
  compartilhar do celular, WhatsApp, baixar QR code e cartaz para imprimir.
- **Segurança ao publicar:** a conta de demonstração tem senha pública (README). O sistema recusa
  cadastrar o endereço público enquanto ela valer, avisa quando o link já é público por outro caminho
  e há uma tela *Minha conta* para trocar a senha (exige a atual, encerra as sessões antigas, bloqueia
  após 5 erros). O sistema não sobe em produção sem `DATA_ENCRYPTION_KEY` e `PASSWORD_PEPPER`
  (sem elas, a chave Pix e os logins seriam perdidos no primeiro reinício).
- **Verificação do endereço (proteção SSRF):** o servidor faz uma chamada a um endereço informado por
  usuário; recusa IP interno/loopback/metadados no momento da conexão (inclusive IP literal e DNS
  apontando para dentro), não segue redirecionamento e limita corpo e tempo.
- **Painel no celular:** o menu estourava a largura em todas as telas; agora rola dentro dele.
- **Testes novos:** 105 (endereços/SSRF), 39 (link, permissões, isolamento entre franquias, senha
  padrão), 14 (troca de senha), 7 (configuração de produção). Mutações provadas: sem a guarda de IP
  literal ou sem revogar sessões, os testes falham.
- **Não verificado:** nada foi publicado em nenhuma hospedagem (o ambiente de desenvolvimento não
  alcança a internet). A verificação de endereço foi testada contra servidores locais e domínios
  inexistentes, não contra um site público real. Ver `docs/PUBLICAR.md`, que também avalia a Vercel.
- **Lacuna conhecida:** não há comando para criar a loja REAL (só a de demonstração). Necessário antes
  de hospedar de fato.
