# Architecture Decision Records

O briefing determina: *"Quando houver decisões técnicas que não foram especificadas, escolha a alternativa
mais segura, escalável e adequada para Android/iOS e explique a decisão."*

Cada decisão dessas está registrada aqui, no formato ADR: **contexto → alternativas → decisão →
consequências**, incluindo as consequências negativas. Um ADR que só lista vantagens não é um ADR — é
publicidade.

| # | Decisão | Status |
|---|---|---|
| [0001](ADR-0001-monolito-modular.md) | Monolito modular em vez de microsserviços | Aceito |
| [0002](ADR-0002-multi-tenancy-rls.md) | Banco compartilhado com Row Level Security | Aceito |
| [0003](ADR-0003-react-native-expo.md) | React Native + Expo para Android e iOS | Aceito |
| [0004](ADR-0004-postgresql-drizzle.md) | PostgreSQL com Drizzle ORM | Aceito |
| [0005](ADR-0005-tokens-e-sessoes.md) | JWT assimétrico curto + refresh opaco rotativo | Aceito |
| [0006](ADR-0006-estoque-reserva-ttl.md) | Reserva de estoque com TTL e `UPDATE` condicional | Aceito |
| [0007](ADR-0007-outbox-transacional.md) | Transactional Outbox para integrações externas | Aceito |
| [0008](ADR-0008-pix-manual-com-abstracao-psp.md) | Pix manual com BR Code EMV atrás de `PaymentProvider` | Aceito |
| [0009](ADR-0009-whatsapp-cloud-api-oficial.md) | Exclusivamente a WhatsApp Business Platform oficial | Aceito |
| [0010](ADR-0010-dinheiro-em-centavos-e-uuidv7.md) | Dinheiro em centavos e chaves UUIDv7 | Aceito |
| [0011](ADR-0011-tempo-real-websocket-push.md) | WebSocket para primeiro plano, push para segundo plano | Aceito |
| [0012](ADR-0012-identidade-de-cliente-global.md) | Conta de cliente global à plataforma | Aceito |

## Formato

```
# ADR-NNNN — Título
Status · Data · Decisores
## Contexto        — as forças em jogo
## Alternativas    — o que foi considerado, com trade-offs honestos
## Decisão         — o que foi escolhido
## Consequências   — positivas E negativas
## Revisitar quando — o gatilho que reabre a discussão
```

O campo **Revisitar quando** existe para que estas decisões não virem dogma. Toda escolha aqui foi feita
para um contexto específico; quando o contexto mudar, a decisão deve ser reaberta sem cerimônia.
