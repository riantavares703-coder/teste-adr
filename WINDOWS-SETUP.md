# Setup e Testes no Windows (PC)

Guia completo para rodar a plataforma no Windows.

## 1. Instalação Rápida

### Opção A: Automática (recomendado)

```bash
# Duplo-clique em setup-windows.bat
# OU no PowerShell:
.\setup-windows.bat
```

Isso instala:
- ✓ Node.js (se não tiver)
- ✓ pnpm (package manager)
- ✓ Todas as dependências do projeto

### Opção B: Manual

```powershell
# 1. Instalar Node.js
#    Baixe em: https://nodejs.org (versão LTS)

# 2. Instalar pnpm
npm install -g pnpm

# 3. Instalar dependências do projeto
pnpm install
```

## 2. Rodar Testes

```bash
# Automático
.\test-windows.bat

# Ou manual
pnpm test
```

Resultado esperado: **252 testes passando** (102 domain + 13 client + 137 api)

## 3. Testar Apps Móveis

### 3.1 App do Cliente

```bash
# Automático
.\run-customer-windows.bat

# Ou manual
pnpm --filter mobile-customer dev
```

**Menu de opções:**
```
s - Expo Go (escaneia QR Code)
a - Emulador Android (requer Android Studio)
i - Emulador iOS (não funciona em Windows)
w - Web preview
```

**Recomendado para Windows:**
- **Expo Go + iPhone:** Escaneia QR Code (mais rápido)
- **Emulador Android:** Se tiver Android Studio instalado

### 3.2 App do Operador/Admin

```bash
# Automático
.\run-operator-windows.bat

# Ou manual
pnpm --filter mobile-operator dev
```

**Credenciais padrão:**
```
Email:  admin@franquia-a.com
Senha:  senha123456
```

## 4. Testar com Expo Go (Recomendado)

### Para iPhone

1. **Instalar Expo Go**
   - App Store → procure "Expo Go" → instale

2. **Rodar dev server**
   ```bash
   .\run-customer-windows.bat
   ```
   Aperte `s` para ver QR Code

3. **Scanear no iPhone**
   - Abra Câmera do iPhone
   - Aponte para QR Code na tela
   - Toca na notificação que aparece
   - App abre no Expo Go

### Para Android

1. **Instalar Expo Go**
   - Google Play → procure "Expo Go" → instale

2. **Rodar dev server**
   ```bash
   .\run-customer-windows.bat
   ```
   Aperte `s` para ver QR Code

3. **Scanear no Android**
   - Abra Expo Go
   - Aperte "Scan QR code"
   - Aponte câmera para QR Code
   - App abre

## 5. Testar com Emulador Android

**Requisitos:**
- Android Studio instalado
- Emulador criado (AVD Manager)

**Procedimento:**
```bash
# 1. Inicia Android Studio e abre um emulador

# 2. Roda dev server
.\run-customer-windows.bat

# 3. Aperta 'a' para instalar no emulador
```

## 6. Fluxo de Teste — Cliente

| Tela | O que validar |
|---|---|
| **Branches** | Lista de lojas carrega? Seleção muda de loja? |
| **Menu** | Produtos aparecem? Preços formatados corretamente (R$ 1.234,56)? Tema da franquia aplicado? |
| **Carrinho** | Adicionar/remover itens? Quantidade atualiza preço? |
| **Checkout** | Escolher entrega vs retirada? Métodos de pagamento aparecem? Observação salva? |
| **Pagamento Pix** | Código aparece? Copiar funciona? Timeline do status? |
| **Rastreamento** | Status atualiza? Timeline visual ok? |
| **Tema** | Cores, gradiente e fontes da franquia aplicados corretamente? |

## 7. Fluxo de Teste — Operador

| Tela | O que validar |
|---|---|
| **Login** | Email + password? Entra na organização certa? |
| **Dashboard** | KPIs aparecem (novos, preparando, pronto)? Números fazem sentido? |
| **Pedidos** | Filtro por status funciona? Transições de estado funcionam? |
| **Estoque** | Modo "infinito" vs "limitado"? Números atualizam? |
| **Aparência** | Editor de cores/fontes? Preview atualiza em tempo real? |
| **Indicadores** | Filtro por período (7/30/90 dias)? Escopo certo (unidade vs organização)? |

## 8. Validar Segurança — Multi-Tenant

**Em dois emuladores/celulares diferentes:**

```bash
# Celular A (Franquia A)
.\run-customer-windows.bat
# Loga como cliente A, compra em Franquia A

# Celular B (Franquia B)
.\run-customer-windows.bat
# Loga como cliente B, compra em Franquia B
```

**Validar:**
- ✓ Cliente A **não vê** pedido de Cliente B (mesmo copiando ID exato)
- ✓ Operador de Franquia A **não vê** pedidos de Franquia B
- ✓ Indicadores de Franquia A **não incluem** números de Franquia B

## 9. Troubleshooting

### Erro: "pnpm not found"
```bash
npm install -g pnpm
pnpm --version  # confirma
```

### Erro: "ENOENT: no such file"
```bash
# Confirma que está no diretório certo
cd C:\Caminho\Para\teste-adr
pnpm install  # reinstala dependências
```

### Emulador Android não inicia
```bash
# Abre Android Studio
# Tools → Device Manager → cria novo dispositivo (se não tiver)
# Inicia o dispositivo manualmente
# Roda: pnpm --filter mobile-customer dev
# Aperta 'a'
```

### App não carrega (tela branca)
```bash
# Metro bundler pode estar lento. Aguarde 1-2 minutos
# Ou reinicia o dev server: Ctrl+C e volta a rodar
```

## 10. Próximos Passos Recomendados

1. ✓ Rodar testes: `.\test-windows.bat`
2. ✓ Testar cliente com Expo Go: `.\run-customer-windows.bat`
3. ✓ Testar operador com Expo Go: `.\run-operator-windows.bat`
4. ✓ Validar fluxo completo: Branches → Menu → Carrinho → Checkout → Pagamento
5. ✓ Testar isolamento multi-tenant (dois celulares)

---

**Dúvidas?** Veja a documentação completa em `docs/`
