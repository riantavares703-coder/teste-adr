# ADR-0002 — Banco compartilhado com Row Level Security

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Segurança

---

## Contexto

O requisito é explícito: *"Um operador de uma unidade NÃO poderá acessar ou modificar dados de outra
unidade sem uma permissão administrativa explícita."* E: *"Um usuário não pode acessar simplesmente
alterando um ID na URL/API."*

IDOR/BOLA é a vulnerabilidade nº 1 do OWASP API Top 10 e a falha mais comum em SaaS multi-tenant. A defesa
usual — "todo query filtra por `branch_id`" — depende de 100% dos desenvolvedores acertarem em 100% das
consultas, para sempre, inclusive em relatórios escritos às pressas e em correções de madrugada.

Isso é uma aposta ruim. Precisamos de um mecanismo em que o **esquecimento não produza vazamento**.

## Alternativas

| Critério | **A. Banco compartilhado + RLS** | B. Schema por tenant | C. Banco por tenant |
|---|---|---|---|
| Isolamento | Forte (política no banco) | Médio (depende de `search_path`) | Máximo |
| Custo por tenant | Muito baixo | Médio | Alto |
| Migração com 500 unidades | 1 execução | 500 execuções | 500 execuções |
| Relatório consolidado da franquia | Trivial | `UNION` de N schemas | ETL |
| Pool de conexões | 1 pool | 1 pool + troca de `search_path` | N pools — não escala |
| Vazamento por bug de código | **Neutralizado pela RLS** | Possível (`search_path` errado) | Impossível |

A opção B tem o pior equilíbrio: a complexidade de C sem o isolamento de C — e `search_path` é uma
variável de sessão frágil, especialmente com pooling.

## Decisão

**Banco compartilhado, schema compartilhado**, com `organization_id` (e `branch_id` onde aplicável) em
toda tabela multi-tenant, e **duas camadas independentes de isolamento**:

1. **Aplicação** — guard de escopo que carrega o recurso do banco e compara com o escopo do ator
   (nunca confia no ID da URL).
2. **Banco** — PostgreSQL RLS com `ENABLE` + **`FORCE ROW LEVEL SECURITY`**, contexto definido por
   `SET LOCAL app.*` dentro da transação.

Detalhes que fazem isso funcionar:

- A aplicação conecta com papel **`app_user`**, nunca superusuário nem dono das tabelas — donos ignoram
  RLS por padrão, o que anularia tudo.
- `SET LOCAL` vale até o `COMMIT`, o que torna o padrão **seguro com PgBouncer em modo transaction**.
- `SUPER_ADMIN` não escapa em silêncio: o bypass é a flag explícita `app.is_platform_admin`, sempre
  acompanhada de auditoria.
- `app.assert_rls_coverage()` **falha o CI** quando uma tabela nova fica sem política.

## Consequências

**Positivas**
- Um `WHERE` esquecido deixa de ser vazamento entre franquias e passa a ser resultado vazio.
  **Verificado:** consulta idêntica, sem cláusula de tenant, retornou 1 linha para a franquia dona e
  **0 linhas** para a outra; busca pelo UUID exato do pedido alheio também retornou **0**.
- Migrações e operação triviais em escala.
- `organization_id` universal é a chave de shard futura — a migração para banco dedicado por tenant é
  operação de dados, não reescrita.

**Negativas — assumidas conscientemente**
- **RLS tem custo de plano.** Predicados entram em toda consulta. Mitigado por funções `STABLE`, índices
  liderados por `organization_id`/`branch_id` e verificação de `EXPLAIN` nas rotas quentes.
- **Toda requisição precisa rodar em transação** para o `SET LOCAL` valer. É uma regra de infraestrutura
  que precisa ser respeitada por todo caminho de dado — inclusive scripts.
- **Falsa sensação de segurança é o maior risco.** RLS mal configurada parece funcionar. Mitigado pelo
  teste de cobertura bloqueante — que **já pegou duas falhas reais** (`user_roles` e
  `product_modifier_groups` sem política) durante a elaboração desta arquitetura. `user_roles` é a tabela
  que *define* a autorização: sem política, um bug permitiria ler ou forjar concessões de papel de outra
  franquia.
- Tenant barulhento afeta vizinhos. Mitigado por cotas por organização e monitoramento.

## Revisitar quando

- Uma franquia exigir isolamento físico por contrato ou exigência regulatória → mover **aquela**
  organização para banco dedicado, mantendo o mesmo código.
- O custo de plano da RLS aparecer em profiling como gargalo real (não presumido) em rota crítica.
- O volume exigir sharding — momento em que `organization_id` vira chave de roteamento.
