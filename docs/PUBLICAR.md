# Publicar o cardápio na internet

O link e o QR code que o painel gera só servem se o **celular do cliente alcançar o endereço de onde ele
estiver** — em casa, no 4G, na rua. Um endereço como `http://192.168.0.10:3000` só abre para quem está
conectado ao Wi-Fi da loja. Este guia explica como ter um endereço público e o que o sistema faz por você.

> Estado deste guia: o que está descrito como "o sistema faz" foi implementado e testado. As rotas de
> hospedagem (seções 1 a 3) **não foram executadas em nenhuma plataforma** — são o roteiro do que o sistema
> precisa, e o que for citado de terceiros foi consultado em outubro de 2026 e pode mudar.

---

## O que o sistema faz

Na tela **Compartilhar** do painel:

- diz **até onde o link alcança**: *funciona de qualquer lugar* (endereço público), *só no Wi-Fi da loja*
  (rede local) ou *só neste computador*;
- aceita o **endereço público** da loja (ex.: `https://cardapio.minhaloja.com.br`), valida (só `https`, só
  nome de site, nada de IP ou rede interna) e **testa de verdade**: o servidor tenta abrir o endereço pela
  internet e confere que ele leva a esta unidade;
- monta o link e o QR code a partir dele, com botões de copiar, compartilhar, WhatsApp, baixar o QR code e
  **imprimir um cartaz** para a mesa ou o balcão;
- **recusa publicar enquanto a conta de demonstração tiver a senha padrão** (veja o checklist abaixo).

O endereço-base do link é escolhido nesta ordem:

1. o endereço público que o dono cadastrou na tela *Compartilhar*;
2. a variável `PUBLIC_BASE_URL`, se for um endereço público;
3. o endereço pelo qual o próprio painel está aberto, se for público (sistema hospedado);
4. `PUBLIC_BASE_URL` de rede local (o launcher define isto com o IP do computador);
5. o IP do computador na rede local;
6. `localhost` (só funciona no próprio computador).

---

## Caminhos para ter um endereço público

### 1. Hospedar o sistema na internet (recomendado)

O sistema já é um **processo único**: a API também serve o painel e o cardápio. Isso casa com qualquer
plataforma que rode um processo Node contínuo e ofereça PostgreSQL gerenciado. Vantagens: endereço `https`
permanente, funciona com o computador da loja desligado, e mantém tempo real e confirmação automática do Pix
exatamente como hoje.

O que a hospedagem precisa oferecer:

| Necessidade | Detalhe |
|---|---|
| Node.js 20 ou superior | processo contínuo (não "função por requisição") |
| PostgreSQL 16 | gerenciado; use `?sslmode=require` na `DATABASE_URL` se o provedor exigir |
| Disco persistente | fotos dos produtos (`MEDIA_STORAGE_DIR`) — ou volume montado |
| HTTPS | quase todas dão sem custo; o sistema exige `https` no endereço público |

Comandos (a partir da raiz do repositório):

```bash
pnpm install
pnpm --filter @plataforma/domain build
pnpm --filter @plataforma/web-customer build
pnpm --filter @plataforma/web-operator build
pnpm --filter @plataforma/api build

node --conditions=node-dist apps/api/dist/db/migrate.js     # cria/atualiza as tabelas
node --conditions=node-dist apps/api/dist/main.js           # sobe o sistema
```

Variáveis de ambiente (nunca no repositório):

| Variável | Para quê |
|---|---|
| `NODE_ENV=production` | modo de produção (exige as chaves abaixo) |
| `PORT` | porta que a plataforma indicar |
| `DATABASE_URL` | conexão com o PostgreSQL |
| `JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM` | par Ed25519 que assina os logins (sem ele o sistema não sobe em produção) |
| `DATA_ENCRYPTION_KEY` | cifra a chave Pix e o token do Mercado Pago. **Obrigatória e fixa**: se mudar, o que foi cadastrado fica ilegível |
| `PASSWORD_PEPPER` | reforço do hash das senhas. **Obrigatória e fixa**: se mudar, ninguém consegue entrar |
| `MEDIA_STORAGE_DIR` | pasta das fotos (num disco persistente) |
| `PUBLIC_BASE_URL` | endereço público (ex.: `https://pedidos.minhaloja.com.br`) |

O sistema **não sobe em produção** sem `DATA_ENCRYPTION_KEY`, `PASSWORD_PEPPER` (mínimo de 16 caracteres cada)
e o par de chaves de login — de propósito: sem elas ele funcionaria até o primeiro reinício e então perderia o
acesso ao que gravou. **Guarde estes valores em lugar seguro**: perdê-los equivale a perder os dados cifrados.

Para gerar valores aleatórios (uma vez só, e guarde):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # use para DATA_ENCRYPTION_KEY e de novo para PASSWORD_PEPPER
```

Para gerar o par de chaves de login:

```bash
node -e "const {generateKeyPairSync:g}=require('crypto');const k=g('ed25519');console.log(k.privateKey.export({type:'pkcs8',format:'pem'}));console.log(k.publicKey.export({type:'spki',format:'pem'}))"
```

**Atenção — lacuna conhecida:** o único comando que cria uma loja hoje é o de demonstração
(`apps/api/dist/db/seed.js`), que cria a loja `demo` com a conta `admin@demo.local`. Numa hospedagem real
isso precisa de um passo próprio para criar a **sua** loja, com o seu endereço (`/suaLoja/suaUnidade`) e a
sua senha, sem passar pela conta de demonstração. Ainda não existe; é o primeiro item a fazer ao publicar.

### 2. Túnel (o computador da loja continua sendo o servidor)

Um programa no computador da loja (por exemplo, o **Cloudflare Tunnel**) liga o sistema a um endereço
público `https`. Não há hospedagem para pagar, mas:

- o computador precisa ficar **ligado e com internet**; se cair, o link para de funcionar;
- a confirmação automática do Pix e o tempo real só funcionam enquanto ele está ligado;
- endereços de túnel "rápidos" mudam a cada reinício — para o QR code impresso valer, use um endereço fixo
  (túnel nomeado com domínio próprio).

Depois de criar o túnel, defina `PUBLIC_BASE_URL=https://seu-endereco` antes de abrir o launcher, ou cadastre o
endereço na tela *Compartilhar*.

### 3. Vercel — o que dá e o que não dá

A pergunta natural é "posso rodar isto na Vercel?". Resposta curta: **as telas sim; a API como está, não** — e
o sistema inteiro só com ajustes e plano pago.

| Parte | Como é hoje | Na Vercel |
|---|---|---|
| Telas (painel e cardápio) | arquivos estáticos | encaixa bem (CDN, `https` e domínio próprio) |
| API (NestJS) | processo contínuo | possível como função, com os ajustes abaixo |
| Confirmação automática do Pix | a API consulta o Mercado Pago **a cada 5 s** (timer interno) | tarefas agendadas ("cron") rodam no mínimo **1 vez por minuto no plano Pro** e **1 vez por dia no Hobby** |
| Expirar pedidos e fila de notificações | timers internos | também viram cron (1 min no Pro) |
| Tempo real do painel | WebSocket (socket.io) | suporte nativo em **beta** desde 22/06/2026; a conexão cai ao fim do tempo máximo da função (300 s no Hobby, 800 s no Pro) e **conexões em servidores diferentes não conversam** sem um serviço de mensagens (ex.: Redis) |
| Fotos dos produtos | gravadas em disco | o disco da função é **somente leitura** (só `/tmp`, que não persiste) — precisa de armazenamento de arquivos (Vercel Blob, S3 etc.) |
| Banco de dados | PostgreSQL local | externo (ex.: Neon, Supabase), com poucas conexões por instância |
| Plano | — | **o plano gratuito (Hobby) é só para uso pessoal e não comercial; receber pagamentos conta como uso comercial** — o uso real exige o plano Pro |

Fontes consultadas:
[política de uso justo](https://vercel.com/docs/limits/fair-use-guidelines),
[limites de cron](https://vercel.com/docs/cron-jobs/usage-and-pricing),
[WebSocket em beta](https://vercel.com/changelog/websocket-support-is-now-in-public-beta),
[limites de funções](https://vercel.com/docs/functions/limitations).

Três formas de usar a Vercel, da menos para a mais trabalhosa:

- **Só as telas na Vercel, API em outro lugar.** As telas hoje falam com a API no mesmo endereço em que foram
  abertas (`window.location.origin`). Dá para manter isso fazendo a Vercel encaminhar `/v1/*` para a API
  (regra de `rewrites`), mas o WebSocket não passa por esse encaminhamento: o painel cairia na consulta
  periódica que já existe como reserva. Ganho pequeno para uma loja só.
- **Tudo na Vercel.** Exige: trocar o timer do Pix por consulta **sob demanda** (quando o cliente abre a tela do
  pedido) mais um cron de 1 minuto de segurança; mover expiração e notificações para cron; trocar o disco por
  armazenamento de arquivos; limitar as conexões ao banco; e decidir o tempo real (consulta periódica ou
  serviço de mensagens). É viável, mas mexe justamente na parte que confirma pagamento.
- **Hospedagem de processo contínuo (seção 1).** Quase nenhuma mudança de código, mantém o tempo real e a
  confirmação do Pix em 5 s.

---

## Checklist antes de divulgar o link

1. **Troque a senha da conta de demonstração** (painel → seu nome → *Minha conta*). A senha
   `restaurante123` está no manual: com o cardápio na internet, qualquer pessoa poderia entrar no painel —
   que controla a chave Pix da loja. O sistema não deixa cadastrar o endereço público enquanto a senha for a
   padrão, e mostra um aviso vermelho em *Compartilhar* se o link já for público por outro caminho.
2. **Confira a chave Pix** (e, se usar, o token do Mercado Pago) em *Horário → Chave Pix*.
3. **Use `https`.** Pedidos e pagamentos passam por esse endereço. O sistema recusa `http` no cadastro e
   avisa se o endereço vier configurado sem criptografia.
4. **Faça backup do banco de dados** com regularidade.
5. **Teste de fora da rede**: abra o link pelo 4G do seu celular, faça um pedido de teste e confirme que o QR
   code do cartaz impresso abre o cardápio.

## Perguntas frequentes

**O teste de verificação falhou, mas o link abre no meu celular pelo 4G. Está errado?**
Não. O teste sai do servidor da loja e volta pelo endereço público; alguns roteadores não permitem que a
rede "dê a volta" para o próprio endereço público. O que vale é abrir pelo 4G.

**Posso imprimir o QR code antes de publicar?**
Pode, mas ele só funcionará dentro do Wi-Fi da loja (a tela marca o QR code com "Só no Wi-Fi da loja"). Quando
o endereço público for cadastrado, o QR code muda — imprima o cartaz depois.

**O endereço público muda o endereço do painel?**
Não. Ele só muda o link e o QR code que os clientes recebem.
