# Plataforma Multi-Tenant de Pedidos (Conveniência / Fast-Food / Franquias)

Aplicativo mobile (Android + iOS) para **clientes** e **operadores/administradores**, com arquitetura
**multi-tenant** preparada desde o início para franquias com múltiplas unidades.

> **Status deste repositório:** somente **arquitetura técnica**. Nenhuma tela, nenhum componente de UI e
> nenhum código de aplicação foram implementados — por decisão explícita, a arquitetura vem antes.
> Os únicos artefatos "executáveis" aqui são o **DDL do banco** e as **políticas de RLS**, que fazem parte
> do modelo de dados solicitado.

---

## Índice da entrega

A entrega segue exatamente os 10 itens exigidos na **Regra Fundamental**:

| # | Item exigido | Documento |
|---|---|---|
| 1 | Análise da arquitetura | [`docs/00-analise-arquitetural.md`](docs/00-analise-arquitetural.md) |
| 2 | Arquitetura proposta | [`docs/01-arquitetura-do-sistema.md`](docs/01-arquitetura-do-sistema.md) |
| 3 | Modelo de dados | [`docs/02-modelo-de-dados.md`](docs/02-modelo-de-dados.md) · [`docs/sql/schema.sql`](docs/sql/schema.sql) · [`docs/sql/rls-policies.sql`](docs/sql/rls-policies.sql) |
| 4 | Fluxo de autenticação | [`docs/03-fluxo-de-autenticacao.md`](docs/03-fluxo-de-autenticacao.md) |
| 5 | Fluxo de pedido | [`docs/04-fluxo-de-pedido.md`](docs/04-fluxo-de-pedido.md) |
| 6 | Fluxo de estoque | [`docs/05-fluxo-de-estoque-virtual.md`](docs/05-fluxo-de-estoque-virtual.md) |
| 7 | Modelo de permissões | [`docs/06-modelo-de-permissoes.md`](docs/06-modelo-de-permissoes.md) |
| 8 | Estratégia de segurança | [`docs/07-estrategia-de-seguranca.md`](docs/07-estrategia-de-seguranca.md) |
| 9 | Arquitetura de integração WhatsApp | [`docs/08-integracao-whatsapp.md`](docs/08-integracao-whatsapp.md) |
| 10 | Vulnerabilidades e mitigações | [`docs/09-ameacas-e-mitigacoes.md`](docs/09-ameacas-e-mitigacoes.md) |

Documentos complementares:

| Documento | Conteúdo |
|---|---|
| [`docs/10-pagamentos.md`](docs/10-pagamentos.md) | Pix (manual hoje, PSP amanhã), presencial, conciliação, antifraude |
| [`docs/11-roadmap-de-implementacao.md`](docs/11-roadmap-de-implementacao.md) | Fases, critérios de aceite, o que **não** construir agora |
| [`docs/adr/`](docs/adr/) | 12 **Architecture Decision Records** — cada decisão não especificada, com alternativas e justificativa |

---

## Resumo executivo das decisões

| Decisão | Escolha | Por quê (resumo) |
|---|---|---|
| Estilo arquitetural | **Monolito modular** (ports & adapters), extraível em serviços | Pedido + estoque + pagamento exigem **transação ACID única**; microsserviços aqui trariam sagas e inconsistência sem necessidade. [ADR-0001](docs/adr/ADR-0001-monolito-modular.md) |
| Multi-tenancy | **Banco compartilhado + `organization_id`/`branch_id` + PostgreSQL RLS** | Isolamento aplicado no **banco**, não só na aplicação: um `WHERE` esquecido não vaza dados de outra franquia. [ADR-0002](docs/adr/ADR-0002-multi-tenancy-rls.md) |
| Mobile | **React Native + Expo (dev client)**, monorepo com Design System compartilhado | 2 apps (cliente e operador) + painel web reaproveitando tipos e cliente de API gerado do OpenAPI. [ADR-0003](docs/adr/ADR-0003-react-native-expo.md) |
| Backend | **NestJS (TypeScript)** | Guards/Interceptors mapeiam 1:1 em RBAC + escopo de tenant; tipos compartilhados com o mobile. [ADR-0004](docs/adr/ADR-0004-postgresql-drizzle.md) |
| Banco | **PostgreSQL 16+ com Drizzle ORM** | Precisamos de `UPDATE` condicional atômico, `FOR UPDATE`, índices parciais, RLS e particionamento — controle de SQL é requisito, não preferência. [ADR-0004](docs/adr/ADR-0004-postgresql-drizzle.md) |
| Sessão | **Access JWT assimétrico curto (10 min) + refresh opaco rotativo com detecção de reuso** | Revogação imediata, permissões nunca "congeladas" no token, sequestro de sessão detectável. [ADR-0005](docs/adr/ADR-0005-tokens-e-sessoes.md) |
| Estoque | **Reserva com TTL + `UPDATE ... WHERE (on_hand - reserved) >= n` atômico** | Impossível dois clientes levarem a última unidade; o backend é a autoridade final. [ADR-0006](docs/adr/ADR-0006-estoque-reserva-ttl.md) |
| Integrações | **Transactional Outbox + fila (BullMQ/Redis)** | WhatsApp fora do ar **não** derruba pedido: o pedido comita, a mensagem sai depois. [ADR-0007](docs/adr/ADR-0007-outbox-transacional.md) |
| Pix | **BR Code EMV estático gerado localmente + confirmação manual auditada**, atrás de uma porta `PaymentProvider` | Hoje sem custo de PSP e com UX de "Pix Copia e Cola"; amanhã troca-se o adapter e a confirmação vira automática por webhook. [ADR-0008](docs/adr/ADR-0008-pix-manual-com-abstracao-psp.md) |
| WhatsApp | **WhatsApp Business Platform (Cloud API) oficial**, atrás de `WhatsAppService` | Automação não oficial (Baileys / whatsapp-web.js) = risco real de banimento da conta do lojista. [ADR-0009](docs/adr/ADR-0009-whatsapp-cloud-api-oficial.md) |
| Dinheiro | **`BIGINT` em centavos**, nunca `float` | Erro de arredondamento em dinheiro é defeito financeiro. [ADR-0010](docs/adr/ADR-0010-dinheiro-em-centavos-e-uuidv7.md) |
| Identificadores | **UUIDv7** em chaves expostas | Ordenável no tempo (localidade de índice) e não enumerável, diferente de `BIGSERIAL`. [ADR-0010](docs/adr/ADR-0010-dinheiro-em-centavos-e-uuidv7.md) |
| Tempo real | **WebSocket (Redis adapter) + FCM/APNs para background** | Operador precisa ver o pedido chegar; cliente precisa saber "saiu para entrega" com o app fechado. [ADR-0011](docs/adr/ADR-0011-tempo-real-websocket-push.md) |
| Cliente x franquia | **Conta de cliente global + vínculo `customer_organization_links` por franquia** | Cliente não recria conta a cada marca; franquia enxerga **apenas** quem pediu nela (LGPD). [ADR-0012](docs/adr/ADR-0012-identidade-de-cliente-global.md) |

---

## Princípios inegociáveis

1. **O backend é a autoridade final.** Preço, estoque, taxa de entrega, desconto e status **nunca** vêm do cliente.
2. **Negar por padrão.** Toda rota exige papel + escopo (organização → unidade → recurso) explicitamente concedidos.
3. **Isolamento em duas camadas.** Aplicação filtra por tenant *e* o banco impede o vazamento via RLS.
4. **Nada de segredo no app.** Chave de API, token de WhatsApp e credencial de PSP vivem no secret manager, nunca no bundle.
5. **Auditoria imutável.** `audit_logs` e `order_status_history` são append-only, encadeados por hash, sem `UPDATE`/`DELETE` para a aplicação.
6. **Integração externa é opcional para o negócio.** Se WhatsApp, push ou PSP caírem, o pedido continua funcionando.
7. **Dinheiro e estoque só mudam dentro de transação**, com idempotência e trilha de auditoria.

---

## Como ler

Comece por [`docs/00-analise-arquitetural.md`](docs/00-analise-arquitetural.md) (requisitos, drivers e alternativas
descartadas) e siga a numeração. Os diagramas usam **Mermaid** e renderizam direto no GitHub.
