# ADR-0012 — Conta de cliente global à plataforma

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Produto, Privacidade

---

## Contexto

O sistema é multi-tenant e hierárquico: `organização → unidade → …`. Operadores pertencem claramente a
uma organização. **Clientes, não.**

Uma pessoa pode pedir na hamburgueria da rede A no sábado e na conveniência da rede B no domingo — pelo
mesmo aplicativo, ou por apps com marcas diferentes construídos sobre a mesma plataforma. Onde essa conta
vive?

A resposta tem consequências diretas em UX, LGPD e no desenho da RLS, e precisa ser tomada antes da
primeira linha de `users`.

## Alternativas

**A. Cliente pertence a uma organização** (`users.organization_id` obrigatório para todos)
Modelo mais simples e uniforme: toda tabela filtra por `organization_id`, sem exceção.

Consequências ruins e concretas: a pessoa cria conta, verifica telefone e cadastra endereço **de novo** a
cada marca. Como e-mail e telefone precisam ser únicos apenas dentro da organização, a mesma pessoa vira
N registros sem relação entre si. Histórico fragmentado, e — o pior — o cliente não tem como exercer
direitos de LGPD sobre "seus dados" porque eles são N titularidades distintas.

**B. Cliente global à plataforma** (escolhida)
Uma conta, um telefone verificado, endereços reaproveitados, histórico unificado. Custo: `organization_id`
deixa de ser universal em `users`, e a política de RLS de `orders` fica mais elaborada.

**C. Conta global com perfis por organização**
Variação de B com uma tabela de perfil por organização. Complexidade extra sem benefício claro na Fase 1;
os dados realmente específicos por franquia (consentimento, contadores) cabem no vínculo.

## Decisão

**Conta de cliente global à plataforma**, com vínculo explícito por organização.

```sql
users            -- type = 'STAFF'    -> organization_id NOT NULL
                 -- type = 'CUSTOMER' -> organization_id NULL
CHECK (
  (type = 'STAFF'    AND organization_id IS NOT NULL) OR
  (type = 'CUSTOMER' AND organization_id IS NULL)
)

customer_organization_links (
  customer_id, organization_id,
  first_order_at, last_order_at, orders_count,
  whatsapp_opt_in, whatsapp_opt_in_at, marketing_opt_in, opted_out_at
)
```

Unicidade por escopo:
- `UNIQUE (organization_id, email) WHERE type='STAFF'` — operador é único na organização.
- `UNIQUE (email)` e `UNIQUE (phone_e164) WHERE type='CUSTOMER'` — cliente é único na plataforma.

Isso permite, deliberadamente, que a mesma pessoa seja operador da franquia A **e** cliente da franquia B,
com contas separadas — que é o comportamento correto: os papéis não se misturam.

### Consequência na RLS

`orders` precisa de duas políticas mutuamente exclusivas, porque há duas classes legítimas de acesso:

```sql
-- operação: STAFF, dentro da organização, com a unidade em escopo
CREATE POLICY orders_staff_isolation ON orders
  USING (app.current_user_type() = 'STAFF'
         AND app.tenant_visible(organization_id, branch_id));

-- consumo: CUSTOMER, e SOMENTE os próprios pedidos
CREATE POLICY orders_customer_isolation ON orders
  USING (app.current_user_type() = 'CUSTOMER'
         AND customer_id = app.current_user_id());
```

O cliente não pode ser filtrado por `organization_id` — ele é filtrado por **identidade**.

### Consequência na privacidade (o ponto central)

Uma franquia **não** enxerga a base de clientes da plataforma. Só enxerga quem pediu nela, e isso é
imposto pela RLS:

```sql
CREATE POLICY users_customers_of_org ON users
  USING (app.current_user_type() = 'STAFF' AND type = 'CUSTOMER'
         AND EXISTS (SELECT 1 FROM customer_organization_links col
                     WHERE col.customer_id = users.id
                       AND col.organization_id = app.current_org_id()));
```

Consentimento de WhatsApp e marketing é **por organização**: autorizar a rede A não autoriza a rede B.
É a leitura correta da LGPD — consentimento é específico e informado, não transferível.

## Consequências

**Positivas**
- Cliente cadastra e verifica o telefone uma vez; endereços e histórico o seguem entre marcas.
- Direitos de LGPD (acesso, portabilidade, eliminação) operam sobre **uma** titularidade.
- Consentimento granular por franquia, com data e revogação — exatamente o que a Meta e a ANPD exigem.
- Base para funcionalidades futuras (repetir pedido, endereços compartilhados) sem migração.

**Negativas — assumidas conscientemente**
- **`organization_id` não é universal em `users`**, o que quebra a uniformidade do modelo multi-tenant e
  exige atenção especial nas políticas de RLS. É a parte mais sutil do schema e precisa de teste dedicado.
- Políticas de `orders` mais complexas (duas, mutuamente exclusivas) — mais superfície para errar.
- Franquia não "possui" o cliente, o que pode gerar atrito comercial com redes que enxergam a base de
  clientes como ativo próprio. É posição consciente: o titular dos dados é a pessoa, não a loja.
- Um mesmo telefone não pode ser duas contas de cliente — correto, mas exige fluxo de suporte para
  transferência de número.

## Revisitar quando

- Alguma franquia exigir contratualmente base de clientes isolada — atendível criando uma organização com
  app de marca própria e clientes marcados como exclusivos, sem alterar o modelo.
- Surgir necessidade de perfil por organização (preferências, apelido por marca) → adotar a alternativa C
  sobre a mesma base.
- Expansão internacional trouxer exigência de residência de dados por país.
