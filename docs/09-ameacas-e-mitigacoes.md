# 09 — Vulnerabilidades e Mitigações

> Item 10 da Regra Fundamental. Cobre **item por item** a lista do §7 do briefing, acrescenta a modelagem
> STRIDE por fluxo e o mapeamento contra o OWASP API Security Top 10 (2023) e o OWASP Mobile Top 10 (2024).

---

## 1. Catálogo do briefing — cada ameaça e sua mitigação

Legenda de risco residual: 🟢 baixo · 🟡 médio (monitorado) · 🔴 requer aceite explícito.

### 1.1 Autenticação e sessão

| # | Ameaça | Mitigações | Residual |
|---|---|---|---|
| 1 | **Brute force** | Rate limit por conta **e** por IP; bloqueio progressivo (1→2→4→8→30 min); CAPTCHA após 5 falhas; Argon2id de ~250 ms torna o custo por tentativa proibitivo; alerta ao admin | 🟢 |
| 2 | **Credential stuffing** | Cliente usa **OTP, sem senha** (elimina a classe); operador tem bloqueio por lista de senhas vazadas (HIBP k-anonymity); MFA para papéis administrativos; detecção de padrão distribuído por organização | 🟢 |
| 3 | **Enumeração de usuários** | Resposta **e latência** idênticas para conta existente/inexistente em login, OTP e recuperação; verificação de senha executada contra hash *dummy* quando o usuário não existe; recurso fora de escopo devolve `404`, nunca `403` | 🟢 |
| 4 | **Session hijacking** | Access token de 10–15 min; refresh **rotativo com detecção de reuso** (queima a família inteira e avisa o titular); vinculação a `device_id`; TLS 1.3 + HSTS + certificate pinning; token no Keychain/Keystore, nunca em `AsyncStorage` | 🟢 |
| 5 | **JWT mal configurado** | `alg` **fixado no verificador** (nunca lido do token) → imune a `alg:none` e à troca RS256→HS256; EdDSA assimétrico (verificador não consegue forjar); `iss`/`aud`/`exp`/`nbf` validados; `kid` com rotação por JWKS; `sid` conferido contra sessão viva; `ver` conferido contra `token_version` | 🟢 |
| 6 | **Vazamento de tokens** | Nunca em URL, query string, log ou analytics; `Cache-Control: no-store`; redação obrigatória no logger; refresh guardado só como hash SHA-256 | 🟢 |
| 7 | **Replay attacks** | OTP e token de reset de uso único (`consumed_at`/`used_at`); anti-replay do contador TOTP; `Idempotency-Key` em POST; webhook com validação de timestamp (±5 min) e `provider_event_id` único; refresh de uso único por rotação | 🟢 |
| 8 | **Privilege escalation** | Concessão só de papel de **nível estritamente maior**; `role:assign` restrito; escopo verificado contra o recurso carregado do banco; RLS impede escrita fora do tenant; toda concessão auditada e alertada | 🟢 |

### 1.2 Autorização e isolamento

| # | Ameaça | Mitigações | Residual |
|---|---|---|---|
| 9 | **IDOR / BOLA** | **Três camadas independentes:** (a) recurso carregado do banco e comparado ao escopo do ator — nunca se confia no ID da URL; (b) chaves **UUIDv7**, não sequenciais; (c) **RLS no PostgreSQL**. **Verificado:** franquia B consultando o pedido de A pelo UUID exato → **0 linhas** | 🟢 |
| 10 | **Insecure Direct Object References** | Idem acima; `404` em vez de `403` para não confirmar existência; teste de isolamento entre tenants bloqueante no CI | 🟢 |
| 11 | **Acesso entre unidades** | `user_roles` sempre com escopo; acesso cruzado exige **linha explícita** com autor e `expires_at`; guard `@ScopedTo` obrigatório; RLS confere no banco | 🟢 |

### 1.3 Injeção e entrada

| # | Ameaça | Mitigações | Residual |
|---|---|---|---|
| 12 | **SQL Injection** | **Exclusivamente** consultas parametrizadas via Drizzle; SQL cru só por *template tag* que parametriza; nenhuma concatenação de string em consulta; papel de banco com privilégio mínimo; SAST bloqueia padrões de concatenação | 🟢 |
| 13 | **NoSQL Injection** | Não aplicável — não há banco NoSQL. Redis recebe apenas chaves construídas pelo servidor, nunca entrada bruta do usuário | 🟢 |
| 14 | **XSS** | API entrega apenas JSON com `Content-Type` correto e `nosniff`; React Native **não tem DOM**; painel React escapa por padrão e `dangerouslySetInnerHTML` é proibido por lint; CSP restritiva; mídia servida em domínio separado | 🟢 |
| 15 | **CSRF** | API sem cookie de sessão — autenticação por header `Authorization`, que não é enviado automaticamente pelo navegador; se o painel adotar cookie, será `SameSite=Strict` + `Secure` + `HttpOnly` + token anti-CSRF; CORS com origens listadas | 🟢 |
| 16 | **SSRF** | Backend não busca URL do usuário; onde inevitável: allowlist, bloqueio de faixas privadas/link-local/`169.254.169.254`, proteção contra DNS rebinding, sem redirecionamento, egresso restrito por security group, **IMDSv2 obrigatório** | 🟢 |
| 17 | **Path traversal** | Nome de arquivo do usuário **nunca** é usado — `storage_key` é UUID do servidor; sem operação de sistema de arquivos com entrada do usuário; storage de objetos não tem hierarquia de diretório real | 🟢 |
| 18 | **Comandos maliciosos (RCE / command injection)** | Nenhum `exec`/`spawn` com entrada de usuário; processamento de imagem em worker isolado, sem shell; container sem shell na imagem final e sem root; SBOM + SCA | 🟢 |
| 19 | **Mass assignment** | Zod em **modo estrito**: campo não declarado → `400`. DTOs nunca mapeados direto para entidade; `id`, `organization_id`, `status`, `*_cents` jamais aceitos do cliente; teste automatizado envia campos extras em todos os DTOs | 🟢 |

### 1.4 Fraude de negócio

| # | Ameaça | Mitigações | Residual |
|---|---|---|---|
| 20 | **Manipulação de preços** | Preço vem **sempre** do banco; cliente envia só `productId` + `quantity`; `expectedTotalCents` é comparação, nunca fonte; `CHECK (total = subtotal + taxa − desconto)` no banco (**verificado**); snapshot imutável em `order_items` | 🟢 |
| 21 | **Manipulação de quantidade** | `CHECK (quantity BETWEEN 1 AND 999)`; total de linha calculado no servidor e validado por `CHECK`; reserva atômica recusa quantidade indisponível | 🟢 |
| 22 | **Manipulação de estoque** | `UPDATE` condicional atômico; `CHECK (reserved_qty <= on_hand_qty)` (**verificado**); disponibilidade nunca vem do cliente; ajuste manual exige permissão, motivo e auditoria; razão append-only com reconciliação diária | 🟢 |
| 23 | **Manipulação de pedidos** | Máquina de estados com transições declaradas; sem pulo de etapa; estados terminais sem saída; `order_status_history` imutável (**verificado**); campos financeiros nunca editáveis por API após criação | 🟢 |
| 24 | **Fraude de pagamento** | Copiar chave Pix **não** confirma nada; confirmação exige `payment:confirm` + registro de ator/IP/horário; relatório de divergência; alerta em confirmação fora do horário; estoque só é debitado na confirmação; na Fase 2, confirmação por webhook assinado do PSP conferindo valor **e** `txid` | 🟡 — fraude interna do operador é mitigada por auditoria e conciliação, não eliminada. Elimina-se com integração de PSP (Fase 2) |
| 25 | **Abuso de APIs** | Rate limit por rota/identidade/IP; cotas por organização; paginação limitada a 100; attestation (Play Integrity/App Attest) em rotas sensíveis; WAF com regras gerenciadas; detecção de anomalia | 🟡 |

### 1.5 Infraestrutura e dados

| # | Ameaça | Mitigações | Residual |
|---|---|---|---|
| 26 | **Upload de arquivos maliciosos** | Allowlist de tipo; limite de tamanho; verificação de **magic bytes**; **reprocessamento com `sharp`** (a imagem é reescrita, destruindo polyglot/payload); EXIF removido; antivírus; nome de arquivo descartado; bucket privado; domínio separado | 🟢 |
| 27 | **Exposição de secrets** | Secret manager com IAM role; nada em `.env` versionado, imagem ou log; `whatsapp_integrations` guarda **referência**, não token; gitleaks no CI e no histórico; rotação ensaiada | 🟢 |
| 28 | **DoS em endpoints sensíveis** | Anti-DDoS na borda (Cloudflare); rate limit por camada; limite de payload (256 KB); Argon2id com custo limitado + tamanho máximo de senha; timeout em toda operação; pool de conexões limitado; filas separadas por criticidade; autoscaling | 🟡 — DoS volumétrico depende do provedor de borda |

---

## 2. Modelagem STRIDE por fluxo crítico

### 2.1 Criação de pedido

| Categoria | Ameaça concreta | Mitigação |
|---|---|---|
| **S**poofing | Pedido em nome de outro cliente | `customer_id` vem do token, nunca do corpo |
| **T**ampering | Alterar preço/quantidade/total | Recálculo no servidor + `CHECK`s de banco |
| **R**epudiation | "Nunca fiz esse pedido" | `audit_logs` com IP/dispositivo + `order_status_history` imutável |
| **I**nformation disclosure | Ler pedido de outro cliente | RLS + verificação de posse + `404` (**verificado**) |
| **D**enial of service | Inundar a unidade de pedidos falsos | Rate limit por cliente/unidade; attestation; expiração de reserva devolve o estoque |
| **E**levation of privilege | Cliente forçando status `CONFIRMED` | `status` não é campo aceito na criação; transição exige permissão |

### 2.2 Confirmação de pagamento (Pix manual)

| Categoria | Ameaça concreta | Mitigação |
|---|---|---|
| **S**poofing | Cliente alega ter pago | Só operador com `payment:confirm` confirma |
| **T**ampering | Confirmar valor diferente do pedido | Valor vem de `orders.total_cents`, não da requisição |
| **R**epudiation | Operador nega ter confirmado | `confirmed_by` + `confirmed_ip` + `confirmed_at` + auditoria |
| **I**nformation disclosure | Chave Pix de outra unidade | Cifrada, escopo por unidade, RLS, exibida mascarada |
| **D**enial of service | Não confirmar de propósito | Expiração automática + relatório de pedidos parados |
| **E**levation of privilege | Operador troca a chave Pix para a dele | `pix_settings:update` negado a `OPERATOR`; step-up MFA; alerta ao admin da franquia |

### 2.3 Alteração de estoque

| Categoria | Ameaça concreta | Mitigação |
|---|---|---|
| **S**poofing | Alteração atribuída a outro operador | Ator vem do token; `sold_out_by` gravado pelo servidor |
| **T**ampering | Estoque negativo ou reserva fantasma | `CHECK`s + operações idempotentes (**verificado**) |
| **R**epudiation | Negar ter esgotado o produto | Razão append-only com ator, motivo e horário |
| **I**nformation disclosure | Ver estoque de unidade concorrente | Escopo + RLS (**verificado**: 0 linhas) |
| **D**enial of service | Esgotar tudo para sabotar a loja | Permissão exigida, auditoria, alerta ao gerente |
| **E**levation of privilege | Operador alterando outra unidade | Guard de escopo + RLS |

---

## 3. OWASP API Security Top 10 (2023)

| Risco | Como é endereçado |
|---|---|
| **API1 — Broken Object Level Authorization** | Recurso carregado do banco e comparado ao escopo; UUIDv7; **RLS**; `404` fora de escopo; teste de isolamento bloqueante no CI |
| **API2 — Broken Authentication** | Argon2id + pepper, MFA, tokens curtos, refresh rotativo com detecção de reuso, `token_version` |
| **API3 — Broken Object Property Level Authorization** | Zod estrito na entrada; serializador explícito na saída; campo novo não vaza por padrão |
| **API4 — Unrestricted Resource Consumption** | Rate limit multinível, paginação limitada, limite de payload, timeouts, cotas por organização |
| **API5 — Broken Function Level Authorization** | `@RequirePermission` obrigatório; rota sem decorador falha o build; matriz papel×rota testada |
| **API6 — Unrestricted Access to Sensitive Business Flows** | Attestation em criação de pedido e OTP; limite por cliente/unidade; expiração de reserva |
| **API7 — Server Side Request Forgery** | Sem busca de URL do usuário; allowlist, bloqueio de IP privado, IMDSv2, egresso restrito |
| **API8 — Security Misconfiguration** | IaC revisado, cabeçalhos padronizados, sem `debug` em produção, imagem mínima, `assert_rls_coverage()` no CI |
| **API9 — Improper Inventory Management** | OpenAPI como fonte única, versionamento `/v1`, ambientes isolados, política de depreciação, sem endpoint de teste em produção |
| **API10 — Unsafe Consumption of APIs** | Webhooks com assinatura verificada, timeout, circuit breaker, validação de schema do que a Meta/PSP envia |

---

## 4. OWASP Mobile Top 10 (2024)

| Risco | Como é endereçado |
|---|---|
| M1 Credenciais impróprias | Zero segredos no bundle; OTP para cliente |
| M2 Cadeia de suprimentos | Lockfile, SCA, SBOM, revisão de major |
| M3 Autenticação/autorização insegura | Toda autorização no servidor; app não decide nada |
| M4 Validação de entrada/saída | Validação dupla; a do servidor é a que vale |
| M5 Comunicação insegura | TLS 1.3, pinning, sem tráfego em claro |
| M6 Controle de privacidade | Minimização, consentimento granular, anonimização |
| M7 Proteção de binário | Hermes, R8, sem log em release (dificultam, não protegem) |
| M8 Configuração incorreta | `FLAG_SECURE`, backup desabilitado, deep links verificados |
| M9 Armazenamento inseguro | Keychain/Keystore; nada sensível em `AsyncStorage` |
| M10 Criptografia insuficiente | Primitivas de bibliotecas auditadas; nada caseiro |

---

## 5. Riscos aceitos conscientemente

Nenhuma arquitetura honesta tem só 🟢. Estes são os riscos residuais, com quem decide sobre eles:

| Risco | Por que não é eliminado agora | Compensação | Reavaliar |
|---|---|---|---|
| **Confirmação manual de Pix permite fraude interna do operador** | Não há contrato com PSP na Fase 1 (restrição C2 do briefing) | Auditoria completa com ator/IP/horário, relatório de divergência, alerta fora de horário, separação de deveres configurável | **Eliminado na Fase 2** com webhook assinado do PSP |
| Interceptação de OTP por SIM swap | SMS é o canal universal no Brasil | Preferência por WhatsApp; operações sensíveis exigem step-up | Fase 3: passkeys |
| DoS volumétrico | Depende do provedor de borda | Cloudflare + autoscaling + degradação graciosa | Contínuo |
| Operador legítimo abusa do próprio acesso | Ele precisa desse acesso para trabalhar | Auditoria imutável, alertas por limite, relatórios ao gerente | Contínuo |
| Vazamento por engenharia social do lojista | Fora do perímetro técnico | MFA obrigatório para admin, alerta de novo dispositivo, material de orientação | Contínuo |
| Dependência da disponibilidade da Meta | Terceiro | Outbox + fila + fallback para push; pedido nunca afetado | Contínuo |

---

## 6. Verificação contínua

| Controle | Como é verificado | Frequência |
|---|---|---|
| Isolamento entre tenants | Suíte automatizada por rota + `assert_rls_coverage()` | Todo commit |
| Concorrência de estoque | Teste com processos paralelos (40 e 60 concorrentes) | Todo commit |
| Matriz de autorização | Rota × papel, com resultado declarado | Todo commit |
| Mass assignment | Campos extras em todos os DTOs | Todo commit |
| Dependências vulneráveis | SCA + Renovate | Diário |
| Segredos vazados | gitleaks (código e histórico) | Todo commit |
| SAST | Semgrep/CodeQL | Todo commit |
| DAST | ZAP em staging | Semanal |
| Cadeia de hash da auditoria | Job de verificação | Diário |
| Reconciliação de estoque | Razão vs. saldo | Diário |
| Pentest externo | Empresa especializada | Anual + a cada mudança estrutural |
| Ensaio de restauração e rotação | Procedimento documentado | Trimestral |

> Os itens marcados como **verificado** neste documento não são aspiracionais: foram executados contra
> PostgreSQL 16.13 durante a elaboração da arquitetura. Resultados em
> [`02-modelo-de-dados.md §15`](02-modelo-de-dados.md#15-validação-executada).
