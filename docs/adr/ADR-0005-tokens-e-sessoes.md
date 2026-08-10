# ADR-0005 — JWT assimétrico curto + refresh opaco rotativo

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Segurança

---

## Contexto

O briefing exige sessões seguras, refresh token seguro, revogação de sessões, logout de todos os
dispositivos e proteção contra *session hijacking*, *replay* e JWT mal configurado.

A tensão clássica: JWT *stateless* escala bem mas **não revoga**; sessão de servidor revoga na hora mas
consulta o banco a cada requisição. O erro comum é escolher um dos extremos.

## Alternativas

**A. JWT longo e stateless** (1–7 dias, permissões embutidas)
Escala perfeitamente e é indefensável neste produto: demitir um operador não tira o acesso dele até o
token expirar. Papel revogado continua valendo. Token roubado é acesso garantido pelo prazo inteiro.

**B. Sessão opaca de servidor** (consulta o banco sempre)
Revoga instantaneamente, mas cria dependência dura do banco em toda requisição e complica a extração
futura de serviços.

**C. Provedor externo** (Auth0, Cognito, Firebase Auth)
Descartado por três razões concretas: multi-tenancy hierárquico com escopo por unidade não é o modelo
deles (a autorização acabaria dividida em dois lugares — o pior arranjo para auditar); custo por MAU
cresce junto com a métrica que queremos ver crescer; e `token_version`, detecção de reuso de refresh e
revogação imediata exigem controle do ciclo de vida da sessão que esses provedores expõem de forma
limitada.

**D. Híbrido: access curto + refresh opaco rotativo** (escolhida)

## Decisão

### Access token — JWT de 10–15 min

```
alg: EdDSA (Ed25519), assimétrico
claims: iss, aud, sub, sid, jti, typ, org, ver, amr, iat, exp
```

Cinco decisões, cada uma fechando um vetor conhecido:

1. **Assimétrico.** Nunca `HS256`. Com segredo compartilhado, todo serviço que *verifica* também
   consegue *forjar*.
2. **`alg` fixado no verificador**, nunca lido do token. Anula `alg:none` e a troca RS256→HS256 usando a
   chave pública como segredo.
3. **Permissões fora do token.** Só `sub`, `sid`, `org`, `ver`. Resolvidas por requisição, com cache Redis
   de 5 min chaveado por `user_id:token_version`. Papel revogado deixa de valer em segundos.
4. **`ver` conferido contra `users.token_version`.** Incrementar invalida todos os access tokens do
   usuário instantaneamente — é o "sair de todos os dispositivos".
5. **`sid` conferido contra a sessão viva.** Token com sessão revogada é rejeitado dentro do prazo.

### Refresh token — opaco, rotativo, com detecção de reuso

256 bits de aleatoriedade criptográfica; **guardado apenas como SHA-256**. Não usa Argon2 porque não é
segredo de baixa entropia como senha — 256 bits aleatórios não sofrem força bruta offline.

**Rotação em toda renovação**, com `family_id` e `replaced_by`. Apresentar um token já rotacionado
significa que existem duas cópias em circulação: ou o atacante usou primeiro, ou o legítimo usou depois do
roubo. Não dá para distinguir — então **a família inteira é revogada**, `token_version` é incrementado e o
titular é avisado.

**Janela de graça de 10 s** para o token imediatamente anterior, vindo do mesmo `device_id`, sem disparar
o alarme. Sem isso, uma corrida legítima entre duas requisições produziria logout aleatório.

### TTLs

| | Access | Refresh |
|---|---|---|
| Cliente | 15 min | 60 dias |
| Operador | 10 min | 7 dias (+ expiração por 12 h de inatividade) |

## Consequências

**Positivas**
- Revogação efetiva em segundos, sem consultar o banco a cada requisição.
- Roubo de refresh token vira **incidente detectado e contido**, não acesso silencioso permanente.
- Chave privada só no módulo `identity`; rotação por `kid`/JWKS sem invalidar tokens vivos.
- Sem custo por usuário ativo e sem *lock-in*.

**Negativas — assumidas conscientemente**
- Mais código próprio que um provedor pronto — e código de autenticação é código de alto risco. Mitigado
  por usar bibliotecas auditadas (`jose`, `libsodium`, `otplib`): implementamos o **fluxo**, nunca a
  **primitiva**.
- Janela de até 5 min de permissão obsoleta em cenário benigno (cache). Zero no cenário que importa,
  porque revogação explícita invalida a chave.
- Refresh rotativo exige gravação a cada renovação.
- Detecção de reuso pode gerar falso positivo em rede muito instável — daí a janela de graça, que é um
  ajuste de sensibilidade a ser calibrado com dados reais.

## Revisitar quando

- Surgirem clientes de terceiros que exijam OAuth2/OIDC completo — hipótese em que colocamos um servidor
  OIDC **na frente**, sem trocar o modelo interno.
- Suporte a passkeys (WebAuthn) entrar no roadmap, eliminando senha também para operadores.
- Falsos positivos de detecção de reuso passarem de um limiar aceitável em produção.
