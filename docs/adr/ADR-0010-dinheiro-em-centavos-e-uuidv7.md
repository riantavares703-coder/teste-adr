# ADR-0010 — Dinheiro em centavos e chaves UUIDv7

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Backend

---

Duas decisões pequenas, tomadas juntas porque ambas são **irreversíveis na prática**: mudar o tipo da
chave primária ou a representação de dinheiro depois que existem milhões de linhas e integrações é
migração de alto risco. Custam nada agora e custam caro depois.

---

## Parte 1 — Dinheiro em `BIGINT` de centavos

### Contexto
O sistema calcula subtotal, taxa de entrega, desconto e total, e precisa que `total = subtotal + taxa −
desconto` seja **sempre** verdade.

### Alternativas

**A. `FLOAT`/`DOUBLE`** — inaceitável. `0.1 + 0.2 = 0.30000000000000004` em ponto flutuante binário.
Somar centenas de itens acumula erro até aparecer diferença de centavo no fechamento do caixa. É a origem
clássica do bug financeiro que ninguém consegue reproduzir.

**B. `NUMERIC(12,2)`** — correto (aritmética decimal exata). Custos: mais lento que inteiro, e em
JavaScript é serializado como string, exigindo biblioteca de decimal em toda a stack. Aceitável, mas
troca um problema por uma disciplina.

**C. `BIGINT` em centavos** (escolhida) — inteiro exato, rápido, indexável, sem ambiguidade. Cabe até
~92 quatrilhões de centavos.

### Decisão

Todo valor monetário é `BIGINT` de centavos, com `currency CHAR(3)` explícito ao lado. Nomes de coluna
terminam em `_cents` — o tipo fica visível em toda leitura de código.

Regras:
- Arredondamento **só na apresentação**; o cálculo é sempre inteiro.
- Divisão (rateio de desconto entre itens) usa distribuição do resto, para a soma das partes bater com o
  todo.
- `CHECK (total_cents = subtotal_cents + delivery_fee_cents - discount_cents)` no banco.
- `CHECK (line_total_cents = (unit_price_cents + options_total_cents) * quantity)`.
- Nenhum valor monetário é aceito do cliente.

### Consequências

**Positivas** — aritmética exata; `CHECK`s tornam erro de cálculo uma transação abortada em vez de uma
cobrança errada (**verificado**: total inconsistente é recusado por `orders_total_chk`); `number` do
JavaScript representa centavos com segurança até ~90 trilhões, dispensando biblioteca decimal.

**Negativas** — toda formatação precisa dividir por 100 (centralizado em um helper do pacote `domain`);
moeda com 3 casas decimais exigiria migração; percentual (desconto de 10%) precisa de regra de
arredondamento explícita.

---

## Parte 2 — Chaves primárias em UUIDv7

### Contexto
A chave primária aparece em URL, resposta de API e log. É superfície de ataque e fator de desempenho.

### Alternativas

| | `BIGSERIAL` | `UUIDv4` | **`UUIDv7`** |
|---|---|---|---|
| Enumerável | **Sim** — `/orders/1041` revela o pedido anterior | Não | Não |
| Localidade de índice | Ótima | **Ruim** — inserções aleatórias fragmentam o B-tree | Ótima (ordenado no tempo) |
| Vazamento de negócio | **Sim** — ID revela volume total de pedidos | Não | Parcial (só o instante de criação) |
| Geração distribuída | Não | Sim | Sim |
| Tamanho | 8 bytes | 16 bytes | 16 bytes |
| Ordenável por criação | Sim | **Não** | **Sim** |

`BIGSERIAL` está descartado por segurança: ID sequencial é convite a IDOR e vaza métrica de negócio (a
concorrência descobre quantos pedidos a rede processa comparando dois IDs).

`UUIDv4` resolve a enumeração e cria um problema de desempenho: valores aleatórios espalham inserções por
todo o índice, causando fragmentação e mais I/O — exatamente nas tabelas que mais crescem (`orders`,
`audit_logs`, `inventory_movements`).

### Decisão

**UUIDv7** — 48 bits de timestamp em milissegundos + 74 bits aleatórios. Não enumerável **e** ordenado no
tempo, unindo as vantagens das duas alternativas.

Implementado por `app.uuid_generate_v7()` (PostgreSQL 18 traz `uuidv7()` nativo). A aplicação também pode
gerar, o que é útil para preencher relações antes de escrever.

**Separado disso, o número amigável do pedido continua sequencial e curto** (`#1042`), por unidade, em
`order_number_counters`. Ninguém dita um UUID por telefone. O UUID é o identificador técnico; o número
amigável é o identificador humano — e ele é **único por unidade**, nunca global, então não vaza o volume
da rede.

### Consequências

**Positivas** — enumeração impossível; localidade de índice preservada; geração distribuída sem
coordenação (essencial para sharding futuro); ordenação natural por criação dispensa índice adicional em
alguns casos. **Verificado:** 50 pedidos simultâneos geraram 50 números amigáveis distintos, sem colisão.

**Negativas — assumidas conscientemente** — 16 bytes em vez de 8 (impacto real em tabelas com muitas FKs,
aceito); `uuid` é menos legível em depuração manual (mitigado pelo número amigável); expõe o **instante
de criação** do registro, o que é vazamento aceitável (o pedido já traz `placed_at`); a função própria
precisa ser substituída pela nativa quando migrarmos para o PostgreSQL 18.

---

## Revisitar quando

- Migração para PostgreSQL 18+ → trocar `app.uuid_generate_v7()` pela função nativa.
- Necessidade de moeda com precisão diferente de 2 casas.
- Alguma tabela de altíssimo volume (telemetria de entrega) justificar `BIGINT` interno — desde que **não**
  seja exposta em API.
