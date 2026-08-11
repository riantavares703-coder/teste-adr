# Desvios da arquitetura aprovada

> O Prompt 02 determina: *"utilizando EXATAMENTE a arquitetura aprovada anteriormente… Não altere a
> arquitetura sem antes explicar o motivo."*
>
> A implementação segue a arquitetura do Prompt 01. Houve **quatro desvios**, listados aqui com o
> motivo de cada um. Três decorrem de exigências do próprio Prompt 02; um decorre do ambiente.

---

## D1 — `order_status` não contém mais `AWAITING_PAYMENT`

**Origem:** exigência explícita do Prompt 02, item 7.

> *"O pedido deverá possuir estado de pagamento separado do estado do pedido. (…) Não misturar essas
> duas máquinas de estado."*

**O que mudou.** A arquitetura do Prompt 01 tinha `AWAITING_PAYMENT` dentro de `order_status` — porque o
próprio Prompt 01 sugeria o fluxo `PENDENTE → PAGAMENTO PENDENTE → CONFIRMADO`. Isso é justamente a
mistura que o item 7 proíbe: um estado de pagamento morando no enum do pedido.

O enum implementado é:

```
PENDING · CONFIRMED · PREPARING · READY · AWAITING_PICKUP · OUT_FOR_DELIVERY
PICKED_UP · DELIVERED · CANCELLED · REJECTED · EXPIRED
```

**Como o requisito do Prompt 01 continua atendido.** "Aguardando pagamento" não desapareceu — deixou de
ser um estado armazenado e passou a ser **derivado na apresentação**:

```
order.status = PENDING  +  payment.status = AWAITING_CONFIRMATION   →  "Aguardando pagamento"
```

As duas dimensões ficam visíveis lado a lado na tela de acompanhamento e no card do operador.

**Consequência prática que ganha com isso:** um pedido pode estar `PREPARING` com pagamento `PENDING`
(pagamento presencial, cobrado na entrega) — combinação que era inexpressável quando as máquinas estavam
fundidas. Há teste travando essa independência
(`test/order-flow.test.ts` → *"as duas máquinas de estado são independentes"*), e outro garantindo que
nenhum valor de `order_status` case com `/PAY|PAID|PAGAMENT/i`.

**Acoplamento residual, deliberado:** a transição `PENDING → CONFIRMED` verifica o pagamento **apenas
quando o método é PIX**. Não é mistura de estados: é uma regra de negócio (não aceitar pedido Pix não
pago) que lê o estado da outra máquina, sem armazená-lo.

---

## D2 — `products` ganhou `is_featured`, `notes` e `allows_customer_notes`

**Origem:** exigência do Prompt 02, item 1, que lista entre os campos do produto **destaque** e
**observações** — ausentes no modelo do Prompt 01.

| Coluna | Papel |
|---|---|
| `is_featured` | Destaque no cardápio; alimenta a vitrine "Destaques" e tem índice parcial próprio |
| `notes` | Observações **internas** do produto, visíveis só à operação |
| `allows_customer_notes` | Se o cliente pode escrever observação naquele item (ex.: "sem cebola") |

`allows_customer_notes` não foi pedido explicitamente, mas separa duas coisas que o briefing junta na
palavra "observações": a anotação do lojista sobre o produto e a anotação do cliente sobre o item. Sem a
separação, um dos dois usos ficaria sem lugar.

---

## D3 — `product_images` ganhou as variantes geradas

**Origem:** exigência do Prompt 02, item 2 — *"redimensionamento, compressão, geração de thumbnails"*.

Acrescentadas `thumb_storage_key` e `medium_storage_key`. O upload gera três versões (1600px, 800px,
200px) em WebP, e o cardápio consome a miniatura em vez da imagem cheia — o que muda materialmente o
consumo de dados do cliente numa lista com dezenas de produtos.

---

## D4 — Sem PostGIS: `latitude`/`longitude` em `double precision`

**Origem:** ambiente. Diferente dos três anteriores, este desvio **não** vem de um requisito — vem de o
PostGIS não estar disponível onde o schema é aplicado e testado.

| | Arquitetura aprovada | Implementado |
|---|---|---|
| Coordenadas | `geography(Point, 4326)` | `latitude` / `longitude` em `double precision`, com `CHECK` de faixa |
| Zona por raio | `ST_DWithin` | Haversine em TypeScript |
| Zona por polígono | `geography(Polygon)` + índice GiST | **Não implementado** |
| Zona por faixa de CEP | Comparação de texto | Igual |

**O que isso custa:** zonas de entrega por **polígono** ficam de fora. Raio e faixa de CEP — que cobrem a
necessidade da Fase 1 — funcionam normalmente e têm teste.

**Como voltar:** habilitar PostGIS, migrar as duas colunas para `geography(Point, 4326)`, reintroduzir o
tipo `POLYGON` no enum `delivery_zone_type` e trocar o Haversine por `ST_DWithin`. A resolução de zona
está isolada em um único método (`OrderingService.resolveDeliveryZone`), então a troca é local.

---

## O que **não** mudou

Para deixar claro o tamanho real do delta, tudo abaixo foi implementado exatamente como aprovado:

| Decisão | Onde está |
|---|---|
| Monolito modular, ports & adapters ([ADR-0001](adr/ADR-0001-monolito-modular.md)) | `apps/api/src/modules/*` |
| Banco compartilhado + RLS ([ADR-0002](adr/ADR-0002-multi-tenancy-rls.md)) | `migrations/0003_rls.sql`, `Database.withTenant` |
| React Native + Expo ([ADR-0003](adr/ADR-0003-react-native-expo.md)) | `apps/mobile-customer`, `apps/mobile-operator` |
| PostgreSQL + Drizzle ([ADR-0004](adr/ADR-0004-postgresql-drizzle.md)) | `db/schema.ts` + migrações em SQL |
| JWT EdDSA curto + refresh rotativo com detecção de reuso ([ADR-0005](adr/ADR-0005-tokens-e-sessoes.md)) | `modules/auth/*` |
| Reserva com TTL + `UPDATE` condicional atômico ([ADR-0006](adr/ADR-0006-estoque-reserva-ttl.md)) | `InventoryService.reserveForOrder` |
| Transactional Outbox ([ADR-0007](adr/ADR-0007-outbox-transacional.md)) | `OutboxService`, `NotificationService.drainOutbox` |
| Pix manual com BR Code atrás de `PaymentProvider` ([ADR-0008](adr/ADR-0008-pix-manual-com-abstracao-psp.md)) | `payment-provider.ts` |
| Só WhatsApp Cloud API oficial ([ADR-0009](adr/ADR-0009-whatsapp-cloud-api-oficial.md)) | `whatsapp.provider.ts` |
| Centavos + UUIDv7 ([ADR-0010](adr/ADR-0010-dinheiro-em-centavos-e-uuidv7.md)) | `common/uuid.ts`, colunas `*_cents` |
| WebSocket + push ([ADR-0011](adr/ADR-0011-tempo-real-websocket-push.md)) | `realtime.gateway.ts`, `push.provider.ts` |
| Cliente global à plataforma ([ADR-0012](adr/ADR-0012-identidade-de-cliente-global.md)) | `users.type`, `customer_organization_links` |

---

## Um ajuste que a implementação exigiu (sem mudar a arquitetura)

**Contexto de tenant do cliente no checkout.** O ADR-0012 define o cliente como global — ele não pertence
a organização nenhuma. Mas o checkout opera sobre dados de **uma loja**: cardápio, estoque, zona de
entrega, chave Pix. Com `organization_id = NULL`, a RLS corretamente não deixava o cliente enxergar nem a
unidade onde estava comprando.

A solução foi o **contexto de vitrine** (`OrderingService.storefrontContext`): ao comprar, o cliente entra
no tenant daquela loja, com escopo restrito àquela unidade. A organização vem do **banco**, a partir do
`branchId` — nunca de um header enviado pelo cliente.

Isso não afrouxa o isolamento, e há teste para cada afirmação:

- `orders_customer_isolation` continua exigindo `customer_id = current_user` → ele só vê os próprios
  pedidos (*"cliente B não vê pedido do cliente A pelo ID exato"*);
- `users_customers_of_org` exige `STAFF` → ele não lista outros clientes;
- o que passa a enxergar (produtos, preços, unidade) é a vitrine pública daquela loja.

É um refinamento de aplicação do ADR-0012, não uma revisão dele — por isso está aqui e não como novo ADR.

---

# Prompt 03 — camada visual, branding e multifranquia

O Prompt 03 não altera nenhuma decisão dos dois anteriores: nenhuma máquina de estado, nenhuma regra de
estoque, nenhuma política de RLS mudou. O que ele acrescenta é uma camada nova, com as mesmas garantias de
segurança do backend aplicadas à personalização visual.

## D5 — Identidade visual como enumeração, nunca como estilo livre

**Origem:** exigência explícita — *"Não permitir que o usuário injete CSS ou HTML arbitrário."*

A defesa não é sanitização de string; é ausência de superfície. `packages/domain/src/branding.ts` define:

- **fonte** como token de uma lista fechada de seis valores (`INTER` … `DM_SANS`), nunca um nome de família
  livre — `fontFamilyOf()` devolve `undefined` para qualquer token desconhecido, e é isso que impede um
  valor hostil de virar `fontFamily` num `StyleSheet`;
- **gradiente** como token de estilo fechado (`NONE`, `VERTICAL`, `HORIZONTAL`, `DIAGONAL`,
  `DIAGONAL_REVERSE`) — os ângulos são do sistema, não do lojista;
- **cor** validada por regex ancorada `^#[0-9a-fA-F]{6}$` e reemitida normalizada.

O que é gravado em `branding_settings` (migração `0004_branding_and_analytics.sql`) não é estilo — é
enumeração. Duas camadas independentes recusam o que foge disso: o Zod `.strict()` no controller (campo
não declarado nunca é ignorado em silêncio, é rejeitado) e os tipos `brand_font`/`gradient_style` do
PostgreSQL, que recusam mesmo uma gravação feita por fora da API. Há teste para as duas camadas em
`apps/api/test/branding-and-analytics.test.ts`.

## D6 — Contraste é validação, não sugestão

O item 11 pede acessibilidade; tratá-la como recomendação de UI é como não pedir nada. `contrastIssues()`
recusa combinações abaixo do mínimo WCAG 2.1 AA (4,5:1 para texto, 3:1 para a cor principal contra o
fundo) — o servidor devolve 422 com os problemas encontrados, e o card/botão inválido nunca é publicado.

A cor de texto sobre botão (`onPrimary`, `onAccent`) **não é configurável**: é derivada por `bestTextOn()`,
que escolhe entre preto e branco puros. Isso não é estético — é o que torna **impossível** o lojista
publicar um botão com texto invisível, porque não existe campo para errar. O teste varre 4096 cores do
espaço RGB e prova que o pior caso alcançável ainda é 4,583:1, acima do piso exigido — a garantia é
estrutural, não amostral.

## D7 — Tema resolvido no servidor, não recalculado no app

`GET /v1/public/:org/:branch/menu` devolve `theme` já com as cores derivadas (`onPrimary`, `border`,
`overlay`, `mutedText`) prontas — o mesmo `resolveTheme()` do domínio que o editor de aparência usa no
preview. Dois apps em versões diferentes desenham a marca de forma idêntica, e uma regra de contraste nova
no servidor não exige atualizar o app para valer.

## D8 — Indicadores consolidados como superfície de agregação, com o mesmo isolamento de sempre

O item 8 pediu totais por franquia. `AnalyticsService.resolveScope()` decide **no servidor** quais unidades
entram na soma — nunca a partir de um parâmetro do cliente: `isPlatformAdmin`/`isOrgWide` somam a
organização inteira; qualquer outro papel soma apenas `principal.branchScope`. Uma unidade pedida
explicitamente passa por `BranchAccessService.assertAccess` antes de tocar o banco, e a consulta roda sob
RLS como qualquer outra — três camadas, porque agregação é o tipo de vazamento que não aparece num teste de
"não vejo o pedido do outro" (nenhuma linha de `orders` sai da resposta, só um número que não deveria
existir). `apps/api/test/branding-and-analytics.test.ts` tem uma seção dedicada a essa classe de vazamento.

## Extensões de schema

| Tabela/coluna | Papel |
|---|---|
| `branding_settings.{accent,text,background,card}_color` | As cinco cores do item 1 (a sexta, principal, já existia) |
| `branding_settings.{gradient_from,gradient_to,gradient_style}` | Gradiente do item 3 |
| `branding_settings.font_token` | Tipografia do item 2, tipo `brand_font` |
| `branding_settings.icon_storage_key` | Ícone/favicon do item 1 |
| `branding_settings.updated_by` | Quem alterou a aparência, para a auditoria |
| `orders_org_placed_idx`, `orders_org_revenue_idx` | Suportam a agregação do item 8 sem varredura sequencial |

## O que ficou fora — lista objetiva para produção

O Prompt 03 pediu, ao final, uma lista do que falta para considerar o produto pronto para produção. Nada
abaixo é regressão desta entrega — são lacunas já conhecidas dos Prompts 01/02 (repetidas aqui por
completude) mais as que a camada visual expôs:

**Segurança e autenticação**
- MFA/TOTP para conta de administrador (mencionado no modelo de ameaças, não implementado).
- Fluxo de recuperação de senha para STAFF (hoje um `UNIT_MANAGER` reseta a senha de outro usuário).
- Rate limiting distribuído (hoje em memória do processo; precisa de Redis para múltiplas instâncias).
- Cache de permissões distribuído (mesma razão).

**Pagamento**
- Adapter de PSP real com webhook — a confirmação de Pix continua manual (ADR-0008, por decisão explícita
  do Prompt 01, mas é o maior "não fingir integração real" que resta antes de produção).

**Geolocalização**
- PostGIS + zonas de entrega por polígono (D4) — raio e CEP cobrem a Fase 1.

**Aparência (o que este prompt implementa parcialmente)**
- Upload de logo/ícone pelo editor de aparência: o campo `iconStorageKey` existe no schema e a leitura já
  funciona; falta o botão de upload no app do administrador (o pipeline de mídia do Prompt 02
  — `MediaService` — já processa qualquer imagem enviada, é reutilizável sem mudança).
- Paleta de cores por acessibilidade (ex.: simulação de daltonismo) — o contraste mínimo AA está garantido;
  WCAG AAA e verificação de daltonismo não.
- Fontes carregadas via `expo-font`: os tokens e o mapeamento de família já existem
  (`fontFamilyOf`); falta empacotar os arquivos `.ttf` das seis fontes nos binários e chamar
  `Font.loadAsync` na inicialização — sem isso, o app usa a fonte padrão do sistema como fallback
  silencioso (comportamento seguro, mas não é a tipografia escolhida).

**Observabilidade**
- Sem APM/tracing distribuído; logs estruturados existem, mas não há agregador configurado.
- Sem alerta automático para atraso de pedido — o "ATRASADOS" do painel é client-side (recalculado a cada
  carga), não um job de servidor com notificação.

**Não verificado neste ambiente**
- Os apps foram type-checados (`tsc --noEmit`, saída limpa nos três pacotes e nos dois apps) mas **não**
  executados em emulador Android/iOS — não há emulador disponível neste ambiente. Layout, gestos e
  microinterações não foram observados visualmente, só revisados por leitura de código e pelos testes de
  dados que os alimentam.
