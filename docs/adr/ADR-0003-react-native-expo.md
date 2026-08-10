# ADR-0003 — React Native + Expo para Android e iOS

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Mobile

---

## Contexto

Dois aplicativos nativos (Android + iOS): **cliente** e **operador/entregador**. Mais um painel
administrativo web. Equipe pequena (2–5 pessoas na fase inicial).

Requisitos específicos que restringem a escolha:

- App do operador precisa de **notificação com som em segundo plano**, tela sempre acesa e tolerância a
  rede instável (restrição C4).
- Impressão de comanda em **impressora térmica** por Bluetooth/rede será exigida (restrição C5).
- Correções de bug precisam chegar rápido, sem esperar dias de revisão de loja.
- Identidade visual precisa variar por franquia sem *fork* de código.

## Alternativas

**A. Nativo puro (Kotlin + Swift)**
Melhor integração e desempenho. Custo: duas bases, dois times ou um time com competência dupla, cada
funcionalidade implementada duas vezes. Inviável com a equipe prevista.

**B. Flutter**
Excelente desempenho e UI consistente. Ecossistema maduro. Perda decisiva neste projeto: **Dart não
compartilha tipos com o backend TypeScript**. Os schemas Zod que validam o pedido no servidor não podem
ser reaproveitados no app; o cliente de API precisa ser gerado para outra linguagem, e o cálculo de
totais precisa ser reimplementado em Dart — com risco de divergir da regra do servidor.

**C. React Native + Expo** (escolhida)

**D. PWA**
Descartada: notificação em segundo plano no iOS é limitada demais para o app do operador, e não há acesso
confiável a impressora Bluetooth.

## Decisão

**React Native + Expo com dev client** (não Expo Go, por causa dos módulos nativos de impressão),
TypeScript, em monorepo com o backend.

Composição:

| Camada | Escolha | Motivo |
|---|---|---|
| Estado de servidor | TanStack Query | Cache, revalidação, retry e suporte a offline sem código próprio |
| Estado local | Zustand | O carrinho é o único estado local relevante; Redux seria cerimônia |
| Navegação | Expo Router | Rotas por arquivo, deep links tipados |
| Armazenamento seguro | `expo-secure-store` | Keychain/Keystore |
| Push | `expo-notifications` sobre FCM/APNs | Uma API para as duas plataformas |
| Atualização | EAS Update (OTA) | Correção de JS em horas, não dias |
| Build/CI | EAS Build | Sem manter máquina macOS |

**O ganho decisivo é o pacote `contracts` compartilhado**: os mesmos schemas Zod validam no app (para
UX imediata) e no servidor (para segurança), e o cliente de API é gerado do OpenAPI. Divergência entre o
que o app envia e o que o servidor aceita vira **erro de compilação**, não bug em produção.

## Consequências

**Positivas**
- Uma base para dois apps e duas plataformas; DS e regras de domínio compartilhados.
- Tipos ponta a ponta do banco à tela.
- OTA permite corrigir sem depender do ciclo das lojas.
- Tematização por franquia é troca de tokens de design em tempo de execução.

**Negativas — assumidas conscientemente**
- **Desempenho abaixo do nativo** em animações complexas e listas muito longas. Mitigado por Hermes,
  `FlashList` e New Architecture. O perfil de uso (listas de cardápio e fila de pedidos) não é exigente.
- **Módulo nativo de impressora térmica precisará de código nativo** — provavelmente um módulo próprio.
  É o ponto de maior risco técnico do mobile, e por isso deve ser prototipado **na Fase 6, cedo**, não
  descoberto no fim.
- Dependência do ecossistema Expo; sair dele depois tem custo (mitigado por prebuild, que gera os
  projetos nativos).
- Tamanho de app maior que nativo puro.
- OTA tem regras de loja: só JS/assets, nunca módulo nativo ou mudança de funcionalidade substancial.

## Revisitar quando

- O módulo de impressão se mostrar inviável em RN após o protótipo — hipótese em que o **app do operador**
  (só ele) pode ir para nativo, mantendo o app do cliente em RN.
- Alguma tela crítica não atingir 60 fps depois de otimizada.
- A equipe crescer a ponto de comportar dois times nativos e o desempenho virar diferencial competitivo.
