# 03 — Fluxo de Autenticação

> Item 4 da Regra Fundamental.

---

## 1. Duas populações, dois modelos de credencial

Tratar cliente e operador com o mesmo fluxo seria errado nos dois sentidos: burocrático demais para quem
só quer pedir um lanche, frouxo demais para quem altera preço e confirma pagamento.

| | **Cliente** | **Operador / Administrador** |
|---|---|---|
| Credencial primária | **Telefone + OTP** (sem senha) | E-mail + senha |
| Alternativa | E-mail + senha (opcional) | — |
| MFA | Não | **TOTP obrigatório** para `FRANCHISE_ADMIN` e `SUPER_ADMIN`; opcional para `UNIT_MANAGER` |
| Access token | 15 min | 10 min |
| Refresh token | 60 dias (rotativo) | 7 dias (rotativo) |
| Sessões simultâneas | Ilimitadas | Máx. 5 dispositivos, com lista e revogação |
| Inatividade | — | Expira em 12 h sem uso |

**Por que OTP para o cliente:** elimina de uma vez *credential stuffing*, senha reutilizada e o fluxo de
"esqueci a senha" — que é historicamente a superfície mais atacada de qualquer app de consumo. Como o
telefone já é necessário para a entrega e para o WhatsApp, não há atrito adicional. O trade-off (custo por
SMS e dependência da operadora) é mitigado enviando o OTP preferencialmente pelo **WhatsApp**, com SMS
como fallback.

---

## 2. Especificação dos tokens

### Access token (JWT)

```
Header   { "alg": "EdDSA", "kid": "2026-08-key-01", "typ": "at+jwt" }
Payload  {
  "iss": "https://api.plataforma.com.br",
  "aud": "plataforma-api",
  "sub": "<user_id>",
  "sid": "<session_id>",
  "jti": "<uuid>",
  "typ": "STAFF" | "CUSTOMER",
  "org": "<organization_id>",   // ausente para CUSTOMER
  "ver": 7,                     // token_version do usuário
  "amr": ["pwd","otp"],         // como o usuário se autenticou
  "iat": ..., "exp": ...        // 10–15 min
}
```

Cinco decisões explícitas, cada uma fechando um vetor conhecido:

1. **`alg: EdDSA` (Ed25519), assimétrico.** Nunca `HS256`. Segredo compartilhado significa que qualquer
   serviço que *verifica* também consegue *forjar*. A chave privada fica só no módulo `identity`; o resto
   valida pela chave pública via JWKS.
2. **`alg` nunca vem do token.** O algoritmo aceito é fixado no verificador. É o que anula os ataques
   clássicos `alg: none` e "troca RS256 por HS256 usando a chave pública como segredo".
3. **Permissões *não* entram no token.** Só `sub`, `sid`, `org` e `ver`. As permissões são resolvidas por
   requisição (cache Redis de 5 min, chaveado por `user_id:token_version`). Papel revogado deixa de valer
   em segundos — não em 15 minutos.
4. **`ver` é comparado com `users.token_version`.** Incrementar essa coluna invalida **todos** os access
   tokens do usuário instantaneamente: é o "sair de todos os dispositivos" e a resposta a comprometimento.
5. **`sid` é verificado contra a sessão viva.** Um token com sessão revogada é rejeitado mesmo dentro
   do prazo de validade.

### Refresh token

**Opaco**, 256 bits de aleatoriedade criptográfica — não é JWT e não carrega informação. Armazenado
**apenas como hash SHA-256** (`sessions.refresh_token_hash`). Não usa Argon2 porque não é segredo de baixa
entropia como senha: 256 bits aleatórios não são vulneráveis a força bruta offline, e o hash rápido
mantém o refresh barato.

### Armazenamento no dispositivo

| Item | Onde | Por quê |
|---|---|---|
| Refresh token | **iOS Keychain / Android Keystore** (`expo-secure-store`), com `WHEN_UNLOCKED_THIS_DEVICE_ONLY` | Cifrado pelo hardware, não sai em backup do iCloud/Google |
| Access token | **Somente memória** | Nunca persiste; morre quando o app morre |
| Qualquer token | **Nunca** em `AsyncStorage`, `localStorage`, arquivo ou log | Texto plano legível em aparelho com root/jailbreak |

---

## 3. Cadastro e login do cliente (OTP)

```mermaid
sequenceDiagram
    autonumber
    participant App
    participant API
    participant RL as Rate limiter (Redis)
    participant DB as PostgreSQL
    participant WA as WhatsApp/SMS

    App->>API: POST /v1/auth/otp/request { phone }
    API->>RL: checa limites (telefone, IP, dispositivo)
    alt limite excedido
        RL-->>API: bloqueado
        API-->>App: 429 + Retry-After
    end
    API->>API: gera código de 6 dígitos (CSPRNG)
    API->>DB: INSERT otp_codes (hash do código, TTL 5 min)
    API->>WA: envia código (enfileirado)
    API-->>App: 200 { "expiresIn": 300 }
    Note over API,App: Resposta IDÊNTICA para telefone<br/>cadastrado ou não — sem enumeração

    App->>API: POST /v1/auth/otp/verify { phone, code, deviceId }
    API->>DB: busca OTP válido e não consumido
    API->>API: compara em TEMPO CONSTANTE
    alt inválido
        API->>DB: attempts += 1 (invalida após 5)
        API-->>App: 401 genérico
    end
    API->>DB: marca consumido; cria usuário se não existir
    API->>DB: INSERT sessions (hash do refresh, family_id, device)
    API->>DB: INSERT audit_logs (login)
    API-->>App: 200 { accessToken, refreshToken, user }
```

**Controles aplicados**

| Ameaça | Controle |
|---|---|
| Enumeração de usuários | Resposta e **latência** idênticas para telefone existente ou não |
| Força bruta no código | 6 dígitos + máx. 5 tentativas + TTL de 5 min + limite por telefone/IP |
| Bombardeio de SMS (custo) | 1 código a cada 60 s, 5/hora por telefone, limite por IP e por faixa /24 |
| Interceptação de SMS (SIM swap) | Envio preferencial por WhatsApp; operações sensíveis exigem reautenticação |
| Replay do código | `consumed_at` marcado na primeira validação — código é de uso único |
| Enumeração via timing | Comparação por `timingSafeEqual`; caminho de erro com custo artificial equalizado |

---

## 4. Login do operador (senha + MFA)

```mermaid
sequenceDiagram
    autonumber
    participant App as App Operador
    participant API
    participant RL as Rate limiter
    participant DB as PostgreSQL

    App->>API: POST /v1/auth/login { email, password, deviceId }
    API->>RL: limite por IP (10/min) e por e-mail (5/15min)
    API->>DB: SELECT user WHERE email (na organização)
    API->>API: Argon2id.verify(senha, hash)
    Note over API: Executa o verify MESMO se o usuário<br/>não existir (hash dummy) — tempo constante

    alt credencial inválida
        API->>DB: INSERT login_attempts (falha)
        API->>DB: failed_login_count += 1
        API->>API: se >= 5 -> locked_until = now() + backoff
        API-->>App: 401 "credenciais inválidas" (mensagem única)
    end

    alt conta bloqueada
        API-->>App: 401 mensagem IDÊNTICA (não revela o bloqueio)
    end

    alt MFA habilitado
        API->>DB: cria desafio MFA (TTL 5 min, uso único)
        API-->>App: 200 { mfaRequired: true, challengeId }
        App->>API: POST /v1/auth/mfa/verify { challengeId, totp }
        API->>API: valida TOTP (janela ±1, anti-replay do contador)
    end

    API->>DB: zera failed_login_count; cria sessão
    API->>DB: INSERT audit_logs (login bem-sucedido, IP, dispositivo)
    API-->>App: 200 { accessToken, refreshToken }
    API->>API: dispositivo novo? -> alerta por e-mail (outbox)
```

**Política de senha** (NIST SP 800-63B, não as regras folclóricas):

- Mínimo **12 caracteres**, máximo 128 (limite existe para evitar DoS no Argon2).
- **Sem** exigência de "1 maiúscula, 1 símbolo": produz `Senha@123` e nada mais.
- **Bloqueio por lista de senhas vazadas** (k-anonymity contra HIBP, ou lista local) — este é o controle
  que realmente importa contra *credential stuffing*.
- Sem expiração periódica obrigatória. Troca forçada apenas em suspeita de comprometimento.
- Argon2id com `m=64 MiB, t=3, p=1`, calibrado para ~250 ms no hardware de produção.
- **Pepper** via HMAC-SHA256 com chave no KMS **antes** do Argon2: um vazamento só do banco não permite
  ataque offline, porque falta a chave que nunca esteve lá.

**Bloqueio progressivo** (não fixo, para não virar DoS contra o usuário legítimo):

| Falhas consecutivas | Ação |
|---|---|
| 1–4 | Nada |
| 5 | Bloqueio de 1 min + CAPTCHA |
| 6–8 | Backoff exponencial: 2, 4, 8 min |
| 9+ | 30 min + alerta ao administrador da organização + registro em `audit_logs` |

O contador é por **conta** e por **IP**, separadamente. Só por conta permitiria a um atacante travar
contas alheias de propósito (DoS); só por IP seria contornado com botnet.

---

## 5. Renovação de sessão com detecção de reuso

Este é o mecanismo que transforma roubo de token de "acesso silencioso e permanente" em "incidente
detectado e contido em uma tentativa".

```mermaid
sequenceDiagram
    autonumber
    participant App
    participant API
    participant DB as sessions

    App->>API: POST /v1/auth/refresh { refreshToken }
    API->>DB: busca por SHA-256(token)

    alt não encontrado
        API-->>App: 401
    end

    alt token JÁ ROTACIONADO (replaced_by != NULL)
        Note over API,DB: Alguém está usando um token antigo.<br/>Ou é um atacante com cópia roubada,<br/>ou o usuário legítimo após o roubo.<br/>Não dá para distinguir — revoga TUDO.
        API->>DB: revoga a FAMÍLIA inteira (REUSE_DETECTED)
        API->>DB: users.token_version += 1
        API->>DB: audit_logs (security.token_reuse_detected)
        API-->>App: 401 — exige login completo
        API->>API: alerta o usuário por e-mail/push
    end

    alt expirado ou revogado
        API-->>App: 401
    end

    API->>DB: gera NOVO refresh; marca o antigo replaced_by
    API->>DB: mantém o mesmo family_id
    API-->>App: 200 { accessToken, refreshToken }
```

**Rotação em toda renovação.** O token antigo morre no instante em que o novo nasce. Como consequência,
um refresh token roubado só funciona até o app legítimo renovar — e quando o legítimo tentar, a família
é queimada e o usuário é avisado. O atacante ganha, no máximo, uma janela curta; e não ganha silêncio.

Sobre a corrida legítima (duas abas/requisições renovando ao mesmo tempo): há uma **janela de graça de
10 segundos** em que o token imediatamente anterior é aceito **sem** disparar o alarme, desde que venha
do mesmo `device_id`. Sem isso, o mecanismo produziria falsos positivos e logout aleatório.

---

## 6. Encerramento de sessão

| Operação | Efeito |
|---|---|
| Logout | Revoga a sessão atual (`revoked_reason = LOGOUT`); apaga o token do Keychain |
| **Sair de todos os dispositivos** | Revoga todas as sessões + `token_version += 1` → todo access token vira inválido na hora |
| Troca de senha | Revoga todas as sessões **exceto a atual**; notifica por e-mail |
| Revogação pelo admin | `UNIT_MANAGER`+ encerra sessão de operador da própria unidade; sempre auditado |
| Expiração | Job diário limpa sessões vencidas |
| Detecção de reuso | Revoga a família inteira automaticamente |

O usuário vê a lista de sessões ativas (dispositivo, local aproximado por IP, último uso) e revoga
qualquer uma individualmente.

---

## 7. Recuperação de senha

```mermaid
sequenceDiagram
    autonumber
    participant App
    participant API
    participant DB
    participant Mail

    App->>API: POST /v1/auth/password/forgot { email }
    API->>API: rate limit por e-mail e por IP
    API->>DB: busca usuário
    API-->>App: 200 "Se existir uma conta, enviaremos instruções"
    Note over API,App: SEMPRE 200, SEMPRE o mesmo texto,<br/>SEMPRE o mesmo tempo de resposta

    opt usuário existe
        API->>DB: INSERT password_reset_tokens (hash, TTL 15 min, uso único)
        API->>Mail: link com token de 256 bits
    end

    App->>API: POST /v1/auth/password/reset { token, newPassword }
    API->>DB: busca por hash; valida expiração e used_at
    API->>API: valida política + lista de senhas vazadas
    API->>DB: grava Argon2id; marca token usado
    API->>DB: REVOGA TODAS as sessões; token_version += 1
    API->>DB: audit_logs (password.reset)
    API->>Mail: "sua senha foi alterada" (detecta uso indevido)
    API-->>App: 200 — exige novo login
```

Sete controles: resposta indistinguível, token de alta entropia guardado só como hash, TTL curto, uso
único, invalidação de tokens anteriores do mesmo usuário, revogação total de sessões após o reset
(impede que o atacante que causou o reset mantenha acesso) e notificação ao titular.

---

## 8. MFA

- **TOTP (RFC 6238)**, 30 s, janela de ±1 período para tolerar desvio de relógio.
- Segredo cifrado em repouso (`mfa_credentials.secret_encrypted`, envelope KMS).
- **Anti-replay**: o último contador usado é registrado; o mesmo código não passa duas vezes.
- **10 códigos de recuperação** de uso único, exibidos uma única vez, guardados como hash.
- Desabilitar MFA exige senha + código válido, e gera evento de auditoria com alerta.
- Obrigatório para `SUPER_ADMIN` e `FRANCHISE_ADMIN` — quem pode trocar a chave Pix da rede tem que
  provar duas coisas.
- **Reautenticação por operação sensível** (*step-up*): alterar chave Pix, conceder papel, exportar dados
  ou confirmar pagamento acima de um limite exigem senha/MFA recentes (< 5 min), independentemente de a
  sessão estar válida.

---

## 9. Proteções transversais

| Controle | Implementação |
|---|---|
| Rate limiting | Janela deslizante no Redis, por IP, por identidade e por dispositivo; limites separados por rota |
| Anti-automação | CAPTCHA (Turnstile/hCaptcha) após falhas; **Play Integrity / App Attest** em endpoints sensíveis |
| Fixação de sessão | Sessão sempre criada nova no login; nada é reaproveitado |
| Timing attack | `timingSafeEqual` em toda comparação de segredo; verificação de senha em caminho dummy quando o usuário não existe |
| Log seguro | Senha, token, OTP e chave Pix **nunca** são logados — redação obrigatória no logger |
| Cabeçalhos | `Cache-Control: no-store` em toda resposta de autenticação |
| Detecção de anomalia | Login de país/dispositivo novo → alerta; picos de falha por organização → alerta ao SOC |
| Vinculação de dispositivo | `device_id` gravado na sessão; troca de dispositivo com o mesmo refresh é sinal de roubo |
| Relógio | Tolerância de ±60 s em `exp`/`iat`; NTP obrigatório nos servidores |

---

## 10. Por que não um provedor terceiro (Auth0, Cognito, Firebase Auth)

Avaliado e descartado por três motivos concretos, não por preferência:

1. **Multi-tenancy hierárquico com escopo por unidade** não é o modelo desses provedores. Acabaríamos
   com metade da autorização lá e metade aqui — a pior configuração possível para auditar.
2. **Custo por MAU** cresce junto com clientes finais, que é exatamente a métrica que queremos ver crescer.
3. **`token_version`, detecção de reuso de refresh e revogação imediata** exigem controle do ciclo de vida
   da sessão, que os provedores expõem de forma limitada.

O que **não** construímos internamente: criptografia. Argon2id, EdDSA, TOTP e geração de aleatoriedade
vêm de bibliotecas auditadas (`libsodium`/`node:crypto`, `jose`, `otplib`). A regra é implementar o
*fluxo*, nunca a *primitiva*. Ver [ADR-0005](adr/ADR-0005-tokens-e-sessoes.md).
