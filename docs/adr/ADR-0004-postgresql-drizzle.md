# ADR-0004 — PostgreSQL com Drizzle ORM

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Backend

---

## Contexto

O banco precisa sustentar quatro exigências que não são negociáveis:

1. **Concorrência de estoque** — `UPDATE` condicional atômico, `FOR UPDATE SKIP LOCKED`.
2. **Isolamento multi-tenant** — Row Level Security e `SET LOCAL` por transação ([ADR-0002](ADR-0002-multi-tenancy-rls.md)).
3. **Invariantes de negócio no banco** — `CHECK` de aritmética financeira e de estoque, FK composta,
   índices parciais, triggers de imutabilidade.
4. **Crescimento** — particionamento por data, réplicas de leitura, dados geoespaciais.

## Alternativas de banco

| | PostgreSQL | MySQL | MongoDB |
|---|---|---|---|
| RLS nativa | **Sim** | Não (só views) | Não |
| Índice parcial | **Sim** | Não | Parcial |
| `CHECK` real | Sim | 8.0.16+ | Validação de schema, mais fraca |
| Geoespacial | PostGIS | Básico | Bom |
| `JSONB` indexável | Sim | Razoável | Nativo |
| Transação multi-documento | Nativa | Nativa | Custosa e limitada |

Os dados são **fortemente relacionais** (organização → unidade → produto → pedido → item → pagamento) e
**fortemente transacionais**. MongoDB seria a escolha errada para este domínio: as garantias que mais
precisamos são exatamente as que ele relaxa. **PostgreSQL 16+ com PostGIS.**

## Alternativas de acesso a dados

**A. Prisma**
Melhor DX do ecossistema, migrações excelentes. Limitação decisiva: **controle fino de SQL exige escapar
para `$queryRaw`** — e o caminho crítico deste sistema (`UPDATE` condicional de estoque, `FOR UPDATE SKIP
LOCKED`, `SET LOCAL` de RLS, `ON CONFLICT DO UPDATE RETURNING`) é exatamente onde precisamos desse
controle. Teríamos a pior combinação: um ORM que abstrai o SQL fácil e nos devolve o SQL difícil sem
tipagem.

**B. Drizzle** (escolhida)
Sintaxe próxima do SQL, totalmente tipada, sem camada de runtime pesada. Expressa nativamente `UPDATE`
com `WHERE` complexo e `RETURNING`, CTEs, índices parciais e `FOR UPDATE`. Migrações por SQL versionado —
o que é uma vantagem quando o schema tem triggers, políticas de RLS e constraints de exclusão que nenhum
gerador expressa bem.

**C. SQL puro com `pg`**
Máximo controle, zero segurança de tipos. Rejeitado: o custo de errar um nome de coluna em refatoração é
alto demais.

**D. TypeORM**
Histórico de comportamento surpreendente em migrações e relações. Rejeitado.

## Decisão

**PostgreSQL 16+ (com PostGIS) e Drizzle ORM.** Migrações em **SQL versionado**, revisadas como código.

Regras de uso:

- **Sempre parametrizado.** Concatenação de string em consulta é bloqueada por SAST no CI.
- **SQL cru só via template tag do Drizzle**, que parametriza — nunca por interpolação.
- Toda requisição multi-tenant roda em transação com `SET LOCAL app.*`.
- Papel `app_user` sem `UPDATE`/`DELETE` nas tabelas append-only.
- Migrações compatíveis para trás: expandir → migrar → contrair.

## Consequências

**Positivas**
- O SQL crítico é escrito exatamente como precisa ser, com tipos. **Verificado:** a operação de reserva
  suportou 40 clientes simultâneos disputando 1 unidade com exatamente 1 venda.
- Invariantes vivem no banco. `CHECK (reserved_qty <= on_hand_qty)` e
  `CHECK (total = subtotal + taxa − desconto)` foram testados e recusam a transação — nenhum bug futuro de
  aplicação consegue contorná-los.
- Migrações em SQL suportam triggers, RLS e `EXCLUDE` — que geradores de ORM não expressam.

**Negativas — assumidas conscientemente**
- Drizzle é mais novo que Prisma: ecossistema menor, menos material, mudanças de API mais frequentes.
- Migrações em SQL escrito à mão exigem mais disciplina e revisão do que migrações geradas.
- Menos abstração significa mais SQL no código — e mais chance de erro de quem não conhece SQL.
  Mitigado por revisão obrigatória e testes de integração contra banco real.
- Acoplamento ao PostgreSQL (RLS, `SKIP LOCKED`, índices parciais, PostGIS). **É acoplamento
  deliberado**: estamos usando o banco pelas garantias que só ele dá; portabilidade não é objetivo.

## Revisitar quando

- Drizzle interromper manutenção ou introduzir quebra incompatível com o esforço de migração.
- A equipe crescer com perfil majoritariamente sem SQL, tornando o custo de revisão maior que o ganho de
  controle.
- Uma tabela específica exigir motor diferente (ex.: série temporal de telemetria de entrega → TimescaleDB
  como extensão, não como substituição).
