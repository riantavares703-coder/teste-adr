# 00 — Análise Arquitetural

> Item 1 da Regra Fundamental: **análise antes da proposta**.
> Este documento não descreve a solução; descreve **o problema**, as forças que atuam sobre ele e as
> alternativas consideradas. A proposta está em [`01-arquitetura-do-sistema.md`](01-arquitetura-do-sistema.md).

---

## 1. Contexto de negócio

Plataforma **B2B2C**: vendemos software para **organizações** (franquias, redes ou lojas independentes),
que por sua vez atendem **consumidores finais** pelo aplicativo.

Três perfis de cliente-empresa, com necessidades diferentes:

| Perfil | Característica dominante | Consequência arquitetural |
|---|---|---|
| Loja de conveniência | Catálogo grande (centenas de SKUs), giro alto, poucos itens preparados | Cardápio precisa ser **cacheável** e paginado; estoque virtual é o gargalo de leitura |
| Fast-food | Catálogo pequeno, alta concorrência em horários de pico, itens preparados sob demanda | Picos de escrita concentrados; máquina de estados de preparo é central |
| Franquia multi-unidade | Mesma marca, dados **isolados** por unidade, administração hierárquica | Multi-tenancy hierárquico + RBAC com escopo é requisito de dia 1, não evolução |

A consequência mais importante: **a unidade (`branch`) é a fronteira operacional real**, não a organização.
Preço, estoque, horário, chave Pix e operadores são por unidade. A organização é a fronteira de
**marca, política e administração**.

---

## 2. Requisitos funcionais (resumo normalizado)

| ID | Requisito | Origem |
|---|---|---|
| RF-01 | Franquia possui N unidades; cada unidade tem catálogo, preços, estoque, pedidos, operadores, horários, meios de pagamento, chave Pix, entrega e identidade visual próprios | §1 do briefing |
| RF-02 | Operador de uma unidade não acessa outra unidade sem permissão administrativa explícita | §1 |
| RF-03 | Cliente navega estabelecimento/cardápio, monta carrinho, escolhe retirada ou entrega, escolhe pagamento, finaliza e acompanha status | §2 |
| RF-04 | Pagamento: Pix (chave cadastrada, exibição, cópia, instruções) + Crédito/Débito/Dinheiro presenciais | §3 |
| RF-05 | Copiar chave Pix **não** confirma pagamento; confirmação manual pelo operador até existir integração | §3 |
| RF-06 | Estoque virtual de disponibilidade decrementa por pedido e zera a exibição do produto | §4 |
| RF-07 | Ação manual "MARCAR COMO ESGOTADO" / reativar, com autor e timestamp registrados | §4 |
| RF-08 | Proteção contra dois clientes comprando a última unidade (transação, concorrência, atomicidade) | §4 |
| RF-09 | Pedido com snapshot de preços, totais, modalidade, endereço, observações, status e histórico **imutável** | §5 |
| RF-10 | Notificação de status por WhatsApp via API oficial, desacoplada do fluxo de pedido | §6 |
| RF-11 | RBAC com 6 papéis e verificação `usuário → organização → unidade → recurso` no backend | §8 |
| RF-12 | `AuditLog` cobrindo autenticação, catálogo, preço, estoque, pedidos, Pix e mudanças administrativas | §10 |

---

## 3. Requisitos não-funcionais com metas mensuráveis

Requisito sem número é opinião. Metas iniciais (revisáveis a cada fase do roadmap):

| Atributo | Meta | Como medimos |
|---|---|---|
| Latência de leitura de cardápio | p95 < 200 ms (cache quente), < 500 ms (frio) | histograma OTel por rota |
| Latência de criação de pedido | p95 < 800 ms ponta a ponta (inclui reserva de estoque) | trace distribuído |
| Throughput de pico | 200 pedidos/min por organização; 2.000/min na plataforma na fase 3 | teste de carga k6 |
| Concorrência de estoque | **0** vendas acima do disponível sob 500 requisições simultâneas no mesmo SKU | teste de concorrência dedicado (§5 de `05-fluxo-de-estoque-virtual.md`) |
| Disponibilidade da API de pedidos | 99,9% mensal | probe sintético + SLO no Grafana |
| Degradação de integrações | WhatsApp/push/PSP indisponíveis ⇒ **0** falhas na criação de pedido | teste de caos: adapter derrubado |
| RPO / RTO | RPO ≤ 5 min (PITR), RTO ≤ 60 min | ensaio de restauração trimestral |
| Entrega de notificação de status | 95% em < 30 s após transição | métrica de fila (lag do outbox) |
| Tamanho do app | < 60 MB (Android), inicialização a frio < 3 s em aparelho mediano | CI de build + Firebase Performance |
| Segurança | 0 vulnerabilidades críticas/altas abertas > 7 dias | SAST/DAST/SCA no pipeline |

---

## 4. Drivers arquiteturais (o que realmente molda o desenho)

Ordenados por força. Estes cinco pontos explicam praticamente toda a proposta.

### D1. Consistência transacional entre pedido, estoque e pagamento
Criar um pedido significa, **no mesmo instante lógico**: validar catálogo, calcular preço no servidor,
reservar estoque de N itens, gerar número amigável e registrar status inicial. Se qualquer passo falhar,
nada pode sobrar. Isso é uma transação ACID clássica — e é o argumento mais forte **contra** microsserviços
nesta fase (ver §7).

### D2. Concorrência sobre um recurso escasso e pontual
O ponto quente não é o sistema: é **uma linha** — o estoque do X-Burger da unidade X no horário de pico.
O desenho precisa de uma operação atômica que não permita *lost update*, sem serializar a aplicação inteira.

### D3. Isolamento multi-tenant como propriedade de segurança
IDOR/BOLA é a vulnerabilidade nº 1 de APIs multi-tenant. Confiar em "todo query tem `WHERE branch_id`"
é confiar em disciplina humana em 100% dos casos, para sempre. Precisamos de uma rede de segurança
no banco.

### D4. Integridade financeira
Preço, taxa, desconto e total precisam ser **recalculados no servidor** e **congelados** no pedido.
Nenhum valor monetário enviado pelo app pode influenciar o que é cobrado.

### D5. Dependências externas não confiáveis
WhatsApp Cloud API, FCM/APNs e futuros PSPs têm indisponibilidade, rate limit e latência fora do nosso
controle. Nenhum deles pode estar no caminho crítico síncrono de um pedido.

---

## 5. Restrições assumidas

Explicitadas porque mudam decisões — se alguma estiver errada, avise antes da Fase 1:

| # | Restrição assumida | Impacto se falsa |
|---|---|---|
| C1 | Mercado brasileiro: BRL, Pix, LGPD, CEP/CPF | Muda pagamentos, endereço e privacidade |
| C2 | Sem contrato com PSP/adquirente no início | Pix manual na Fase 1 (com abstração pronta) |
| C3 | Equipe pequena (2–5 devs) na fase inicial | Reforça monolito modular e stack única (TypeScript) |
| C4 | Operação em loja usa tablet/celular, rede instável | App operador precisa de fila local e reconexão; nada de "só funciona online" |
| C5 | Impressão de comanda térmica será exigida | Requer dev client (não Expo Go puro) — ver [ADR-0003](adr/ADR-0003-react-native-expo.md) |
| C6 | Cloud pública (AWS assumida; portável para GCP) | Nomes de serviço mudam, arquitetura não |

---

## 6. Análise da estratégia de multi-tenancy

Três opções reais, avaliadas contra os drivers:

| Critério | A. Banco compartilhado + colunas de tenant + **RLS** | B. Schema por tenant | C. Banco por tenant |
|---|---|---|---|
| Isolamento | Forte (política no banco) | Forte | Máximo |
| Custo por tenant | Muito baixo | Médio | Alto |
| Migração de schema com 500 unidades | 1 execução | 500 execuções | 500 execuções |
| Consultas cross-tenant (BI da franquia) | Trivial | Difícil (`UNION`) | Muito difícil (ETL) |
| Pool de conexões | 1 pool | 1 pool + `search_path` | N pools — não escala |
| Risco de vazamento por bug de código | Mitigado pela RLS | Mitigado pelo `search_path` (frágil) | Nulo |
| "Tenant barulhento" | Precisa de cotas por org | Idem | Isolado |

**Escolha: A.** O ponto fraco de A é o risco de vazamento por bug de aplicação — e é exatamente isso
que a **RLS elimina**, transformando a política de isolamento em invariante do banco. B tem o pior
trade-off (complexidade de B sem o isolamento de C). C fica reservado a um futuro *tier enterprise*
— e como `organization_id` é a chave de particionamento desde o dia 1, migrar uma organização para
banco próprio é uma operação de dados, não uma reescrita. Detalhes em
[ADR-0002](adr/ADR-0002-multi-tenancy-rls.md).

---

## 7. Análise do estilo arquitetural

| Critério | Monolito modular | Microsserviços |
|---|---|---|
| Transação pedido+estoque+pagamento (D1) | `BEGIN … COMMIT` | Saga + compensação + inconsistência temporária |
| Custo operacional (C3) | 1 deploy, 1 pipeline | N deploys, service mesh, tracing obrigatório |
| Escala independente | Vertical + réplicas + workers separados | Por serviço |
| Tempo até a Fase 1 | Semanas | Meses |
| Risco de acoplamento acidental | Real — mitigado por fronteiras de módulo e revisão | Baixo |

**Escolha: monolito modular** com fronteiras explícitas (cada módulo expõe apenas um *port*; nada de
importar repositório de outro módulo) e **workers separados no mesmo código-base**, escaláveis à parte.
Os candidatos naturais a extração futura já nascem isolados: `notifications` (WhatsApp/push),
`payments` e `reporting`. Ver [ADR-0001](adr/ADR-0001-monolito-modular.md).

---

## 8. Análise de carga e plano de escala por estágio

| Estágio | Escala | Pedidos/dia | Postgres | Ações |
|---|---|---|---|---|
| E1 — Validação | 1–20 unidades | < 2 mil | 1 instância (2 vCPU) | Sem réplica; cache Redis do cardápio; backup PITR |
| E2 — Crescimento | 20–200 unidades | 2 mil–50 mil | +1 réplica de leitura | Relatórios e listagens na réplica; índices parciais; cotas por org |
| E3 — Escala | 200–1.000 unidades | 50 mil–500 mil | Réplicas + `orders`/`order_items`/`audit_logs`/`outbox_events` **particionadas por mês** | Autoscaling da API; workers dedicados por fila; arquivamento frio de partições antigas |
| E4 — Plataforma | > 1.000 unidades | > 500 mil | **Sharding por `organization_id`** ou tier de banco dedicado | Roteador de tenant; org como unidade de migração |

O caminho E1→E4 não exige reescrita porque três decisões são tomadas agora: `organization_id` presente
em toda tabela multi-tenant (chave de shard), chaves **UUIDv7** (ordenáveis, sem colisão entre shards)
e tabelas de crescimento ilimitado já desenhadas para particionamento por data.

---

## 9. Riscos arquiteturais conhecidos

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Contenção na linha de estoque de um SKU muito popular | Média | Alto | `UPDATE` condicional de statement único (lock curtíssimo); itens sempre travados na mesma ordem; modo `INFINITE` evita a linha para quem não controla estoque |
| Pedidos "presos" em `AGUARDANDO_PAGAMENTO` segurando estoque | **Alta** | Alto | Reserva com **TTL** + job de expiração idempotente + alerta de reservas órfãs |
| Confirmação manual de Pix gera fraude interna ou erro | Média | Alto | Confirmação é evento auditado com autor, IP e valor; relatório de divergência; separação de deveres (quem confirma ≠ quem cancela, configurável) |
| Banimento da conta WhatsApp por uso indevido | Baixa (com API oficial) | **Crítico** | Somente API oficial; templates aprovados; opt-in explícito; respeito à janela de 24h |
| RLS mal configurada dá falsa sensação de segurança | Média | Crítico | Suíte de testes de isolamento por tabela no CI (tenta ler dado de outro tenant e **deve** falhar) |
| Vazamento de token no dispositivo | Média | Alto | Keychain/Keystore, refresh rotativo com detecção de reuso, access token de 10 min |
| Custo de mensagens WhatsApp cresce sem controle | Média | Médio | Orçamento por organização, contagem por template, fallback para push |

---

## 10. Fora de escopo nesta fase (explicitamente)

Para evitar arquitetura especulativa: **cupons e programa de fidelidade**, **integração fiscal (NFC-e/SAT)**,
**marketplace de entregadores terceiros**, **BI self-service**, **cardápio por IA**. Os pontos de extensão
existem no modelo de dados (`discount_cents` no pedido, `deliveries.courier_id`, `outbox_events`), mas nada
é construído antes de demanda real. Ver [`11-roadmap-de-implementacao.md`](11-roadmap-de-implementacao.md).
