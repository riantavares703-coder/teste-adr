# ADR-0007 — Transactional Outbox para integrações externas

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura

---

## Contexto

Requisito explícito do briefing: *"A arquitetura deverá separar a lógica de pedidos da integração com
WhatsApp. Se a API do WhatsApp estiver indisponível, o pedido continuará funcionando normalmente."*

O problema técnico é o **dual write**: precisamos gravar o pedido no banco **e** disparar notificações.
São dois sistemas, e não existe transação distribuída entre PostgreSQL e a API da Meta.

Quatro cenários de falha, todos reais:

1. Pedido comita, notificação falha → cliente não é avisado.
2. Notificação sai, transação faz rollback → cliente avisado de pedido inexistente.
3. WhatsApp lento (10 s) dentro da transação → lock de estoque segurado por 10 s → fila de pedidos trava.
4. WhatsApp fora do ar → criação de pedido falha, e a loja para de vender.

O cenário 4 é inaceitável, e é exatamente o que o briefing proíbe.

## Alternativas

**A. Chamada síncrona dentro da transação**
Produz os cenários 3 e 4. A disponibilidade da venda passa a depender da disponibilidade da Meta.

**B. Chamada síncrona após o commit**
Elimina 3 e 4, mas mantém o 1: o processo pode morrer entre o commit e o envio, e a notificação some sem
rastro.

**C. Publicar direto na fila dentro da transação**
Continua sendo dual write: a fila pode aceitar e o banco fazer rollback (cenário 2).

**D. Transactional Outbox** (escolhida)
O evento é gravado **na mesma transação** do fato de negócio. Um relay lê e publica depois.

**E. Change Data Capture (Debezium sobre o WAL)**
Tecnicamente elegante e mais desacoplado, mas adiciona Kafka + Debezium + Connect à operação. Complexidade
desproporcional para a escala inicial (restrição C3).

## Decisão

**Transactional Outbox** com relay e filas BullMQ sobre Redis.

```
BEGIN
  INSERT orders …
  INSERT order_items …
  UPDATE virtual_inventory …        -- reserva
  INSERT order_status_history …
  INSERT outbox_events ('order.created')   ← mesma transação
  INSERT audit_logs …
COMMIT
```

O relay consome com `FOR UPDATE SKIP LOCKED` (permite vários relays em paralelo sem duplicar trabalho),
enfileira e marca `published_at`.

| Propriedade | Como é garantida |
|---|---|
| Atomicidade | Evento e fato comitam juntos — impossível divergirem |
| Entrega | **At-least-once**; o consumidor deduplica por chave de idempotência |
| Ordem | Chave de fila por `order_id` — o cliente não lê "entregue" antes de "saiu para entrega" |
| Retry | Backoff exponencial com jitter; 5 tentativas; depois DLQ com alerta |
| Isolamento de falha | Filas separadas por criticidade: `orders` ≠ `notifications` ≠ `reports` |

## Consequências

**Positivas**
- **A criação de pedido não depende de nenhum sistema externo.** A transação fecha em milissegundos; o
  resto acontece depois. É o requisito do briefing, garantido estruturalmente e não por boa intenção.
- Nada se perde: evento não publicado continua na tabela até ser processado.
- O módulo `ordering` não conhece WhatsApp, push nem PSP — só publica eventos.
- Novos consumidores (BI, ERP, e-mail) entram sem tocar no código de pedidos.
- Falha de integração é visível: `attempts`, `last_error`, DLQ e métrica de lag.

**Negativas — assumidas conscientemente**
- **Entrega eventual**, não imediata. Latência típica de 100–500 ms; sob fila cheia, mais. Aceitável para
  notificação, e por isso o WebSocket (que é imediato) atende a tela aberta.
- **At-least-once obriga todo consumidor a ser idempotente.** Esquecer isso gera mensagem duplicada ao
  cliente. Mitigado por chave `(order_id, to_status, channel)` e por revisão.
- `outbox_events` cresce rápido e precisa de limpeza (job remove publicados com mais de 7 dias).
- Uma tabela a mais escrita em toda transação de negócio.
- O relay é um componente a operar e monitorar — lag do outbox é métrica de primeira classe.

## Revisitar quando

- O volume justificar CDC (Debezium) para eliminar o relay.
- Consumidores externos exigirem *streaming* de eventos, e não notificação pontual.
- O lag do outbox virar gargalo mensurável — antes disso, aumentar paralelismo do relay resolve.
