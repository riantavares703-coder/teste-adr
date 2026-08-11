# Refatoração: Web + Android

**Branch:** `claude/web-and-android-refactor`

## Alterações Realizadas

### Removido
- ❌ `apps/mobile-customer` — React Native Expo para cliente
- ❌ `apps/mobile-operator` — React Native Expo para operador
- ❌ `packages/ui` — Design system mobile (React Native)

### Criado
- ✅ `apps/web-customer` — React web para cardápio virtual
- ✅ `apps/android-operator` — Android nativo (Kotlin/Compose) para operador
- ✅ `packages/ui-web` — Design system web (Tailwind, CSS modules)

### Mantido (Sem mudanças)
- ✅ `apps/api` — Backend (NestJS + PostgreSQL + RLS)
- ✅ `packages/domain` — Lógica de negócio
- ✅ `packages/client` — Cliente HTTP compartilhado
- ✅ `docs/` — Documentação arquitetural

---

## Nova Arquitetura

```
┌─────────────────────────────────────────────────────────┐
│                     Backend API                         │
│              (NestJS + PostgreSQL + RLS)                │
└──────────────┬──────────────────────────┬────────────────┘
               │                          │
        ┌──────▼──────┐          ┌────────▼────────┐
        │ Web Customer │          │ Android Operator│
        │  (React web) │          │   (Kotlin)      │
        │   Menu       │          │   Dashboard     │
        │ Checkout     │          │   Pedidos       │
        │ Tracking     │          │   Estoque       │
        └──────────────┘          └─────────────────┘
               │
         ┌─────▼─────────────┐
         │ Link compartilhável│
         │ http://localhost  │
         │ QR Code           │
         └───────────────────┘
```

---

## Fluxo do Cliente (Web)

1. **Operador** abre app Android
2. **App gera link:** `http://localhost:3000/franquia-a/unidade-1/menu`
3. **Operador compartilha QR code** (SMS, WhatsApp, etc)
4. **Clientes** scaneia QR ou abre link no navegador
5. **Cliente vê cardápio** com tema/branding da franquia
6. **Cliente faz pedido**
7. **Operador vê em tempo real** no painel Android

---

## Estrutura de Pastas

```
apps/
  api/                    (NestJS - sem mudança)
  web-customer/           (React - novo)
    src/
      pages/
        MenuPage.tsx      (cardápio)
        CheckoutPage.tsx  (pagamento)
        TrackingPage.tsx  (rastreamento)
      App.tsx
      main.tsx
    index.html
    vite.config.ts
    package.json

  android-operator/       (Kotlin - novo)
    src/
      MainActivity.kt
      ui/
        screens/
        components/
    build.gradle.kts
    AndroidManifest.xml

packages/
  domain/                 (sem mudança)
  client/                 (sem mudança)
  ui-web/                 (novo - design system web)
    src/
      theme.ts           (tema + branding)
      components.ts      (componentes reutilizáveis)
```

---

## Próximas Etapas

### 1. **Web Customer** (apps/web-customer)
- [ ] Página Menu (listagem de produtos)
- [ ] Carrinho
- [ ] Checkout (pagamento + dados de entrega)
- [ ] Rastreamento de pedido
- [ ] Tema aplicado (cores, fontes, branding)

### 2. **Android Operator** (apps/android-operator)
- [ ] Login (email/senha)
- [ ] Dashboard (KPIs)
- [ ] Fila de pedidos (com transições de status)
- [ ] Geração de link/QR code
- [ ] Estoque (virtual)
- [ ] Editor de aparência (branding)

### 3. **UI Web** (packages/ui-web)
- [ ] Componentes: Button, Card, Form, etc
- [ ] Tema responsivo (Tailwind CSS)
- [ ] Contraste WCAG AA validado
- [ ] Design system documentado

### 4. **Integração API**
- [ ] Rotas web para clientes (`GET /v1/public/:org/:branch/menu`)
- [ ] Rotas Android para operador (mesmas de antes)
- [ ] WebSocket para pedidos em tempo real
- [ ] QR code endpoint (`GET /qr/:franchiseCode`)

---

## Como Começar

```bash
# Setup
pnpm install

# Testes (backend continua igual)
pnpm test

# Dev - Web
cd apps/web-customer
pnpm dev
# http://localhost:3001

# Dev - Android
cd apps/android-operator
# Android Studio → abrir projeto e rodar

# Dev - API (se precisar)
cd apps/api
pnpm db:start
pnpm dev
# http://localhost:3000
```

---

## Mudanças na API (Backend)

Nenhuma mudança é **obrigatória** — o backend funciona com ambos os clientes.

**Recomendado:**
- Rota pública para QR code: `GET /v1/public/qr-code`
- Rota pública para menu (já existe): `GET /v1/public/:org/:branch/menu`
- Validação de referrer/origin para web (CORS)

---

## Status

✅ **Estrutura criada**
⏳ **Implementação em progresso**
- Web customer: placeholders prontos
- Android operator: gradle setup pronto
- UI-web: base pronta

🔄 **A fazer:**
- Componentes visuais
- Integração com API
- WebSocket/realtime
- Testes

---

**Nota:** Esta é uma refatoração arquitetural. O backend, domínio e testes
permanecem intactos. Estamos apenas mudando o tipo de cliente (web + Android
nativo em vez de React Native multiplataforma).
