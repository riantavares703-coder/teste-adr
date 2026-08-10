# ADR-0006 — Reserva de estoque com TTL e `UPDATE` condicional atômico

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Backend

---

## Contexto

Requisito literal do briefing: *"Deve existir proteção contra dois clientes comprarem simultaneamente a
última unidade disponível. Utilize transações, controle de concorrência e operações atômicas no backend.
NUNCA confiar apenas no aplicativo do cliente para controlar estoque. O backend deve ser a autoridade
final."*

Complicador específico do Pix na Fase 1: entre criar o pedido e confirmar o pagamento passam-se minutos.
Durante esse intervalo, a unidade está vendida ou disponível?

## Alternativas de controle de concorrência

**A. Ler-decidir-gravar** (o anti-padrão)
```sql
SELECT on_hand - reserved FROM virtual_inventory WHERE ...;  -- ambos leem 1
UPDATE virtual_inventory SET reserved = reserved + 1 WHERE ...;  -- ambos gravam
```
*Lost update* clássico: duas vendas, uma unidade. O erro está em decidir **fora** do banco.

**B. `SELECT … FOR UPDATE`** (lock pessimista)
Correto, mas custa duas idas ao banco e segura o lock por mais tempo — incluindo o tempo de a aplicação
pensar. Sob pico, aumenta a contenção justamente no produto mais popular.

**C. Lock otimista com coluna `version`**
Correto, mas exige laço de retry na aplicação. Sob alta contenção no mesmo SKU, os retries se acumulam.

**D. Lock distribuído no Redis**
Adiciona dependência externa à correção do estoque. Se o Redis cair ou o lock expirar em momento ruim, a
garantia evapora. **A correção do estoque não pode depender de um sistema fora da transação.**

**E. `UPDATE` condicional de statement único** (escolhida)

## Decisão

### Operação atômica

```sql
UPDATE virtual_inventory
   SET reserved_qty = reserved_qty + $3
 WHERE branch_id = $1 AND product_id = $2
   AND mode = 'LIMITED'
   AND is_manually_sold_out = false
   AND (on_hand_qty - reserved_qty) >= $3
RETURNING on_hand_qty - reserved_qty;
```

`0 linhas` = sem estoque → `409` e `ROLLBACK` do pedido inteiro.

**Por que funciona:** em `READ COMMITTED`, duas transações atualizando a **mesma linha** serializam — a
segunda bloqueia, e ao desbloquear **reavalia o `WHERE` contra a versão nova** (EvalPlanQual). Se o
estoque acabou, o `WHERE` fica falso e o `UPDATE` afeta zero linhas. Uma ida ao banco, lock de
milissegundos, sem retry.

### Rede de segurança no schema

```sql
CHECK (reserved_qty <= on_hand_qty)
```

Mesmo que a consulta seja reescrita errado no futuro, o banco recusa a transação.

### Reserva com TTL

Estoque é **reservado** na criação do pedido e só **debitado** na confirmação do pagamento. Reservas vivem
em `inventory_reservations` com `expires_at` (padrão 15 min, configurável por unidade). Um job a cada 30 s
libera as vencidas usando `FOR UPDATE SKIP LOCKED`.

### Prevenção de deadlock

Itens de um pedido são processados **sempre em ordem crescente de `product_id`**. Ordem total consistente
torna deadlock impossível entre dois pedidos com os mesmos produtos.

## Consequências

**Positivas**
- **Verificado contra PostgreSQL 16.13:** 40 clientes simultâneos disputando 1 unidade → **1 venda**;
  60 disputando 10 → **10 vendas**, estado final exato.
- Uma ida ao banco por item; sem laço de retry; sem dependência externa.
- A garantia sobrevive a bug de aplicação, graças ao `CHECK`.
- Cliente não fica com pedido aceito e produto inexistente.

**Negativas — assumidas conscientemente**
- **Exige `READ COMMITTED`.** Em `REPEATABLE READ`/`SERIALIZABLE`, o mesmo statement levanta erro de
  serialização em vez de reavaliar. Está documentado em [`05`](../05-fluxo-de-estoque-virtual.md) e nos
  comentários do teste, porque é o tipo de detalhe que alguém muda por engano meses depois.
- **Reserva com TTL cria uma nova classe de falha**: pedido preso segurando estoque. É o risco de maior
  probabilidade do sistema. Mitigado pelo job de expiração, por alerta de reserva órfã e por operações
  idempotentes (`WHERE reserved_qty >= $n`).
- Uma linha por produto vira ponto quente sob pico. Mitigado pelo lock curtíssimo e pelo modo `INFINITE`,
  que nem toca a linha para quem não controla quantidade.
- `available` derivado exige `on_hand - reserved` em toda leitura (barato, mas presente em todo lugar).

## Revisitar quando

- Um SKU específico apresentar contenção mensurável em produção — solução conhecida: *sharding* da linha
  em N sub-linhas somadas, adotado **apenas** se o problema for medido, não presumido.
- Surgir estoque compartilhado entre unidades (hoje é estritamente por unidade).
- A integração com PSP (Fase 2) reduzir a janela de pagamento a segundos, tornando o TTL quase irrelevante.
