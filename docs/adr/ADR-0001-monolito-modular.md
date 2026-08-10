# ADR-0001 — Monolito modular em vez de microsserviços

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura

---

## Contexto

O sistema precisa suportar múltiplas franquias, múltiplas unidades e grande volume de pedidos
simultâneos. "Escalável" é frequentemente lido como "microsserviços" — vale examinar se isso se sustenta
neste caso.

A operação central é criar um pedido, e ela exige, **no mesmo instante lógico**:

1. validar o catálogo e recalcular o preço;
2. reservar estoque de N itens;
3. gerar o número amigável da unidade;
4. registrar o status inicial;
5. criar o pagamento;
6. registrar auditoria.

Se qualquer passo falhar, nada pode sobrar — em especial estoque reservado para um pedido que não existe.

## Alternativas

**A. Microsserviços desde o início** (catálogo, estoque, pedidos, pagamentos, notificações)
Os seis passos acima atravessariam três serviços, exigindo uma **saga** com compensação. Consequências
reais: janelas de inconsistência visíveis ao usuário ("reservei, mas o pedido não foi criado"), lógica de
compensação que precisa ser tão correta quanto a lógica principal — mas é exercitada muito menos e por
isso quebra em silêncio — e complexidade operacional (N pipelines, service mesh, tracing obrigatório)
antes do primeiro cliente pagante.

**B. Monolito tradicional**
Sem fronteiras internas, degenera em acoplamento acidental. Em 18 meses, extrair `notifications` custa uma
arqueologia.

**C. Monolito modular** (escolhida)
Um deployable, fronteiras de módulo explícitas e verificadas por lint, workers separados no mesmo
código-base.

## Decisão

**Monolito modular** com ports & adapters. Cada módulo (`identity`, `tenancy`, `catalog`, `inventory`,
`ordering`, `payments`, `delivery`, `notifications`, `audit`) expõe apenas `application` e `ports`;
importar `infrastructure` ou `domain` de outro módulo é erro de lint.

Quatro processos a partir da mesma imagem, com entrypoints diferentes: **API HTTP**, **gateway WebSocket**,
**workers** e **scheduler**. Isso dá isolamento de falha (uma fila travada não consome threads da API) e
escala independente, mantendo custo operacional de monolito.

## Consequências

**Positivas**
- A transação crítica é um `BEGIN…COMMIT`. Sem saga, sem compensação, sem inconsistência temporária.
- Um pipeline, um deploy, um trace. Equipe pequena (restrição C3) consegue operar.
- Refatorar fronteira entre módulos é mover arquivo, não coordenar release entre times.
- Testes de integração rodam contra um banco só.

**Negativas — assumidas conscientemente**
- Escala de recursos é conjunta na API: um módulo pesado força escalar tudo. Mitigado por workers
  separados, que é onde a assimetria costuma aparecer.
- Fronteiras dependem de disciplina. Mitigado por lint, mas lint pode ser desabilitado; exige revisão.
- Falha catastrófica no processo afeta todos os módulos daquele processo. Mitigado pela separação em
  quatro processos e por autoscaling.
- Uma única linguagem para todos os módulos.

## Revisitar quando

- Um módulo tiver perfil de recurso radicalmente diferente (ex.: processamento de imagem consumindo CPU
  que compete com a API) — extrair **aquele** módulo, não todos.
- A equipe passar de ~15 pessoas e o acoplamento de deploy virar gargalo real de entrega.
- Uma franquia exigir isolamento físico contratual — nesse caso a unidade de isolamento é o **tenant**,
  não o serviço (ver [ADR-0002](ADR-0002-multi-tenancy-rls.md)).

A ordem de extração já está definida: `notifications` (sem estado compartilhado), depois `payments`
(fronteira contratual clara), depois `reporting`.
