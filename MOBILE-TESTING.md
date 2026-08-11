# Guia de Testes Mobile — iOS e Android

Instruções detalhadas para testar os apps mobile com Expo Go ou emuladores.

## Arquitetura de Testes

```
Testes Automatizados (252 testes)
├─ Domain (102) → regras de negócio puras
├─ Client (13)  → cliente HTTP + carrinho
└─ API (137)    → integração com banco

Testes Manuais (este documento)
├─ Interface visual
├─ Fluxo de usuário
└─ Isolamento multi-tenant
```

---

## 1. Setup Rápido — Expo Go (Recomendado)

### Windows/Mac/Linux

```bash
# Terminal 1: Dev server
pnpm --filter mobile-customer dev
# Ou: .\run-customer-windows.bat (Windows)

# Menu que aparece:
# s - Expo Go (recomendado)
# a - Android Emulator
# i - iOS Emulator (Mac only)
```

### iPhone (Expo Go)

1. **App Store** → Busque "Expo Go" → Instale
2. **No terminal:** Aperte `s`
3. **Câmera do iPhone:** Aponte para QR Code
4. **Notificação:** Toca em "Open in Expo Go"

### Android (Expo Go)

1. **Play Store** → Busque "Expo Go" → Instale
2. **No terminal:** Aperte `s`
3. **Expo Go:** Aperte "Scan QR code"
4. **App:** Abre automaticamente

---

## 2. Testes — App do Cliente (Customer)

### Checklist Visual

**Tela: Branches (Lojas)**
```
[ ] Lista de lojas carrega sem erro
[ ] Loja padrão é selecionada (visual destacado)
[ ] Trocar de loja muda para a aba Menu
[ ] Scroll funciona se houver muitas lojas
[ ] Nenhuma loja faz requestfora do esperado
```

**Tela: Menu**
```
[ ] Header com tema da franquia (cor principal, gradiente)
[ ] Logo/Icon da franquia aparece (se houver)
[ ] Produtos listam com imagem/preço/disponibilidade
[ ] Preço formatado: R$ 1.234,56 (com separador de mil)
[ ] "Destaque" aparecem em seção especial (is_featured)
[ ] Indisponível ≠ visível / ou aparece diferente
[ ] Scroll infinito carrega mais produtos
```

**Tela: Detalhe do Produto**
```
[ ] Imagem carrega (thumbnail 200px mínimo)
[ ] Nome, descrição, preço aparecem
[ ] Modificadores (ex.: tamanho, adicionais) funcionam
[ ] Quantidade (+ / -) funciona
[ ] "Adicionar ao Carrinho" está habilitado
[ ] Após adicionar, volta para o Menu
```

**Tela: Carrinho**
```
[ ] Itens adicionados listam corretamente
[ ] Quantidade ajustável (+ / -)
[ ] Remover item funciona
[ ] Subtotal atualiza em tempo real
[ ] Botão "Ir para Checkout" habilitado (if cart not empty)
[ ] Tema da franquia mantido
```

**Tela: Checkout**
```
[ ] Opções: Entrega / Retirada
[ ] Se Retirada: mostra endereço da loja
[ ] Se Entrega: aviso sobre zona e taxa de cobertura
[ ] Métodos de pagamento: PIX / Dinheiro / Débito/Crédito
[ ] Campo de observação do pedido (500 caracteres max)
[ ] Resumo: Itens + Subtotal
[ ] Botão "Finalizar Pedido" funciona
```

**Tela: Pagamento (Pix)**
```
[ ] Código Pix (QR Code visual + string) aparece
[ ] Botão "Copiar Código" copia para área de transferência
[ ] Timeline do status:
    - "Aguardando pagamento" (inicial)
    - "Pagamento confirmado" (após confirmar no operador)
[ ] Polling atualiza status sem recarregar
```

**Tela: Rastreamento**
```
[ ] Status atual em destaque (ex.: "Preparando")
[ ] Timeline visual com ícones e timestamps
[ ] Pedido apareça nesta tela após checkout
[ ] Observação do pedido (se houver) aparece
[ ] Contato da loja (telefone) visível
```

### Checklist Funcional

**Autenticação**
```
[ ] Login com telefone (OTP via SMS na produção)
[ ] Session persiste após fechar app
[ ] Logout funciona e apaga sessão
[ ] Token JWT curto (10 min) expirado redireciona para login
```

**Carrinho**
```
[ ] Carrinho persiste ao trocar de tela
[ ] Ao mudar de loja, carrinho limpa (ou avisa)
[ ] Remover último item mostra carrinho vazio
```

**Isolamento Multi-Tenant**
```
[ ] Cliente A não consegue ver pedidos de Cliente B
    → Mesmo copiando UUID de pedido de B, recebe 404 ou 403
[ ] Preços corretos para cada franquia
[ ] Métodos de pagamento variam por franquia (se configurado)
```

**Tema (Branding)**
```
[ ] Cor principal aplicada (botão, header, link)
[ ] Cores derivadas: onPrimary (texto em botão), border, overlay
[ ] Fonte (token) aplicada (se houver no servidor)
[ ] Contraste validado: texto legível sobre fundo
[ ] Gradiente aplicado (se configurado)
```

---

## 3. Testes — App do Operador (Operator)

### Credenciais Padrão

```
Email:    admin@franquia-a.com
Senha:    senha123456
Organização: Franquia A
```

### Checklist Visual

**Tela: Login**
```
[ ] Campo de email
[ ] Campo de senha
[ ] Botão "Entrar"
[ ] Logo/branding da plataforma
[ ] Teclado correto (email type para email)
```

**Tela: Dashboard**
```
[ ] 4 KPI cards:
    ✓ Total de Pedidos
    ✓ Faturamento (R$ formatado)
    ✓ Ticket Médio (R$ formatado)
    ✓ Cancelados
[ ] Números atualizam em tempo real (se houver webhook)
[ ] Tema da franquia aplicado
```

**Tela: Fila de Pedidos**
```
[ ] Abas por status: Novos | Preparando | Pronto | Entrega | ATRASADOS
[ ] Cada pedido mostra:
    - Número amigável (ex.: F-001234)
    - Cliente
    - Total
    - Tempo decorrido
    - Itens (resumo ou quantidade)
[ ] Transições de status funcionam:
    [ ] Novo → Confirmar → Preparando
    [ ] Preparando → Pronto
    [ ] Pronto → Saiu para Entrega / Retirado
[ ] Botão de cancelar funciona (com confirmação)
```

**Tela: Estoque**
```
[ ] Modo "Infinito" (sem limite):
    - Quantidade não é editável
    - Disponibilidade = "Sempre disponível"
[ ] Modo "Limitado":
    - Campo de quantidade editável
    - Alertas de estoque baixo
[ ] Modificadores (adicionais) também têm estoque
```

**Tela: Aparência (Branding)**
```
[ ] Editor de cores:
    ✓ Cor Principal (hex, validada)
    ✓ Cor Secundária
    ✓ Cor de Fundo
    ✓ Cor de Card
    ✓ Cor de Texto
[ ] Preview em tempo real
[ ] Font Token (dropdown com 6 opções)
[ ] Gradiente (dropdown: None | Vertical | Horizontal | Diagonal)
[ ] Validação de contraste:
    - Tenta cor de fundo muito escura com texto escuro
    - Recusa com erro: "Contraste insuficiente (WCAG AA)"
[ ] Salvar funciona
```

**Tela: Indicadores (Analytics)**
```
[ ] Filtro de período: 7 dias | 30 dias | 90 dias
[ ] Se admin da organização:
    - Mostra totais de TODA a franquia
    - Seção "Pedidos por Unidade"
[ ] Se gerente de unidade:
    - Mostra apenas sua unidade
    - Sem seção "Pedidos por Unidade"
[ ] Top 5 produtos mais vendidos
[ ] Números fazem sentido (coerência com pedidos vistos)
```

### Checklist Funcional

**Permissões**
```
[ ] Admin vê todas as abas (Pedidos, Estoque, Aparência, Indicadores)
[ ] Gerente de Unidade não vê "Aparência" (branding:update)
[ ] Operador (STAFF) vê só "Pedidos" e "Estoque"
[ ] Permissões respeitadas em cada ação (transição de status, etc)
```

**Isolamento Multi-Tenant**
```
[ ] Operador de Franquia A não consegue:
    - Ver pedidos de Franquia B
    - Editar estoque de Franquia B
    - Ver indicadores de Franquia B
[ ] Mesmo tentando trucar a URL com branchId de outro,
    recebe 403 Forbidden
```

**Branding em Tempo Real**
```
[ ] Muda cor principal no editor
[ ] Preview atualiza imediatamente
[ ] Salva a cor
[ ] Volta ao Dashboard
[ ] Vai para app do cliente → Recarrega menu
[ ] Novo app cliente vê a cor atualizada
```

---

## 4. Testes de Segurança — Multi-Tenant

### Validar Isolamento Completo

**Setup: 2 celulares/emuladores**

```bash
# Celular A — Franquia A
./run-customer-windows.bat
# Login cliente A
# Compra em Franquia A

# Celular B — Franquia B
./run-customer-windows.bat
# Login cliente B
# Compra em Franquia B
```

**Testes:**

```
[ ] Cliente A não vê pedido de Cliente B
    → Tira o UUID de um pedido de B
    → Tenta acessar via app de A
    → Resultado: 404 "Pedido não encontrado"

[ ] Operador A não vê pedidos de B
    → Login em app operator com user de Franquia A
    → Tenta ver lista de pedidos
    → Resultado: só vê pedidos de Franquia A

[ ] Indicadores de A não incluem números de B
    → Dashboard mostra faturamento de A
    → Franquia B fatura algo diferente
    → Resultado: número de A não muda com vendas de B

[ ] Dados de Banco isolados (RLS)
    → Mesmo que alguém bypassasse a aplicação
    → PostgreSQL RLS impede SELECT de dados de outro tenant
    → Resultado: SELECT COUNT(*) FROM orders
       (sem WHERE organization_id) retorna 0 ou dados errados
```

---

## 5. Testes de Tema (Branding) — Contraste WCAG

### Cores Válidas (Contrastam)

```
[ ] Preto (#000000) fundo em branco - ✓ contraste alto
[ ] Azul (#0066CC) em fundo branco - ✓ contraste > 4.5:1
[ ] Vermelho (#FF0000) em branco - ✓ contraste > 4.5:1
```

### Cores Inválidas (Rejeitadas)

```
[ ] Cinza muito claro (#EEEEEE) texto em branco
    → Erro: "Contraste insuficiente"
    
[ ] Texto branco (#FFFFFF) em amarelo claro
    → Erro: "Contraste insuficiente"
    
[ ] Cor inválida (#GGGGGG)
    → Erro: "Formato de cor inválido (use #RRGGBB)"
```

### Validação de Entrega

```
[ ] Botão com cor inválida nunca é publicado
[ ] Mensagem de erro clara e em português
[ ] Após corrigir, botão de salvar fica disponível
```

---

## 6. Performance e Observabilidade

### Verificar Logs

**No Terminal (dev server):**
```
Procure por:
✓ "User authenticated" → login funcionou
✓ "Order created" → pedido criado
✓ "Theme resolved" → tema aplicado
✗ "Error" → algo deu errado
```

### Medir Tempos

```
[ ] App carrega em < 3s (primeira vez)
[ ] Menu carrega em < 1s
[ ] Adicionar ao carrinho em < 500ms
[ ] Checkout/Finalizar em < 2s
[ ] Mudança de tema (preview) em < 200ms
```

---

## 7. Checklist Final — Pronto para Demo

```
[ ] ✓ Todos os testes automatizados passam (252/252)
[ ] ✓ App customer fluxo completo (branches → menu → checkout → pagamento)
[ ] ✓ App operator fluxo completo (login → dashboard → pedidos → estoque)
[ ] ✓ Branding/tema aplicado corretamente
[ ] ✓ Contraste validado (WCAG AA)
[ ] ✓ Isolamento multi-tenant confirmado
[ ] ✓ Sem erros no console (dev tools)
[ ] ✓ Responsividade OK (testes em celular/tablet)
```

---

## 8. Troubleshooting

### App não carrega

```bash
# 1. Metro bundler lento
#    → Aguarde 1-2 minutos

# 2. Cache corrompido
ctrl+c  # Para o dev server
rm -rf node_modules/.cache
pnpm install
pnpm --filter mobile-customer dev

# 3. Porta 8081 ocupada
#    → Muda o expo dev:
pnpm --filter mobile-customer dev --port 8082
```

### QR Code não funciona

```bash
# 1. Dev server não está rodando
#    → Roda: pnpm --filter mobile-customer dev

# 2. Celular não consegue acessar PC
#    → Mesma rede WiFi?
#    → Firewall bloqueando porta?
#    → Tenta Expo Go em vez de emulador

# 3. Expo Go desatualizado
#    → App Store: atualiza Expo Go
```

### Erro "Cannot find module"

```bash
pnpm install
pnpm --filter mobile-customer dev
```

### Tema não aplica

```bash
# 1. Menu não carregou com tema
#    → Volta para Branches e volta para Menu
#    → Força recarga (shake gesture ou menu dev)

# 2. Fonte não carrega
#    → Fallback para font padrão do sistema
#    → Esperado neste ambiente (expo-font precisa config extra)
```

---

## 9. Próximas Etapas

Após validar tudo acima:

1. **Push para produção** (quando pronto)
2. **Testar em dispositivos reais** (não só emulador)
3. **Validar performance** (com Analytics SDK)
4. **Coletar feedback** de usuários finais

---

**Links úteis:**
- [Documentação Técnica](docs/)
- [Arquitetura de Decisão](docs/adr/)
- [Modelo de Dados](docs/02-modelo-de-dados.md)
- [Modelo de Branding](packages/domain/src/branding.ts)
