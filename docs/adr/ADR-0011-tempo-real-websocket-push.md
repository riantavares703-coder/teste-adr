# ADR-0011 — WebSocket para primeiro plano, push para segundo plano

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Mobile

---

## Contexto

Dois requisitos de tempo real com naturezas diferentes:

1. **Operador precisa saber que chegou pedido.** Se demorar, a comida atrasa e o cliente reclama. O app
   pode estar em primeiro plano (tablet no balcão) ou em segundo plano (celular no bolso).
2. **Cliente precisa acompanhar o status.** Com a tela de acompanhamento aberta, espera ver mudar ao vivo.
   Com o app fechado, precisa ser avisado.

São problemas distintos e não têm a mesma solução.

## Alternativas

**A. Polling**
Simples e resiliente. Custo: latência média de metade do intervalo, e N clientes × 1 requisição a cada
X segundos desperdiça banda e bateria. Para o operador, um intervalo de 30 s é inaceitável; de 2 s,
insustentável.

**B. Server-Sent Events (SSE)**
Unidirecional sobre HTTP, simples, com reconexão automática. Suficiente para o cliente. Para o operador,
faltam confirmação de recebimento e canal de volta, e o suporte em React Native é irregular.

**C. WebSocket**
Bidirecional, baixa latência. Não funciona com o app em segundo plano — o sistema operacional suspende a
conexão.

**D. Somente push (FCM/APNs)**
Funciona em segundo plano, mas **não é confiável para o caminho crítico**: entrega é *best effort*,
sofre atraso e é silenciosamente descartada quando o usuário nega permissão.

## Decisão

**Combinação por estado do aplicativo**, porque nenhum canal isolado resolve os dois casos:

| Situação | Canal primário | Fallback |
|---|---|---|
| Operador em primeiro plano | **WebSocket** (sala `branch:{id}`) + som | Polling a cada 15 s se o WS cair |
| Operador em segundo plano | **FCM/APNs high-priority (data message)** | WebSocket reconecta e sincroniza ao voltar |
| Cliente com tela de acompanhamento aberta | **WebSocket** (sala `order:{id}`) | Polling com backoff 5 s → 30 s |
| Cliente com app fechado | **Push** + **WhatsApp** | Redundância proposital |
| Painel admin | WebSocket | Polling (redes corporativas às vezes bloqueiam WS) |

### Detalhes que definem a segurança e a robustez

- **Autenticação no handshake**, com o access token no cabeçalho — **nunca na query string**, que vaza em
  log de proxy e histórico.
- **Reautorização a cada `join` de sala.** Sem isso, o WebSocket seria um IDOR com outro nome: entrar em
  `order:{uuid}` alheio precisa ser barrado no servidor, com a mesma verificação de escopo e posse do REST.
- **Fanout entre instâncias via Redis Pub/Sub** — o gateway é horizontalmente escalável.
- **Gateway em processo separado** da API HTTP: conexões longas têm perfil de memória próprio, e um deploy
  da API não derruba todas as conexões.
- **Sincronização na reconexão**: ao voltar, o app busca o estado atual por REST em vez de confiar em ter
  recebido todos os eventos. Eventos são otimização de latência; **REST é a fonte da verdade**.
- **O push é apenas gatilho**, nunca portador do dado. Ele diz "algo mudou no pedido X"; o app busca o
  estado real. Assim, push perdido ou fora de ordem não corrompe a tela.

## Consequências

**Positivas**
- Latência de menos de 2 s no caso que mais importa (pedido novo no balcão).
- Sem custo de polling para milhares de clientes ociosos.
- Degradação graciosa: WS fora do ar vira polling — o sistema fica mais lento, não quebra.
- Redundância intencional para o cliente (push + WhatsApp), porque push falha em silêncio com frequência.

**Negativas — assumidas conscientemente**
- **Mais peças**: gateway WS, Redis Pub/Sub, FCM/APNs, mais o caminho de fallback. Cada uma é um ponto de
  falha e um item de monitoramento.
- Conexões longas complicam deploy — exigem *graceful shutdown* e reconexão no cliente.
- Push depende de permissão do usuário e dos serviços do Google/Apple; no Android chinês sem Play
  Services, não funciona. Por isso o WhatsApp entra como terceira via para o cliente.
- Testar tempo real é caro: exige cenários com múltiplos clientes e simulação de rede ruim.
- Reautorização por sala adiciona latência ao `join` (mitigada pelo cache de permissões).

## Revisitar quando

- O número de conexões simultâneas exigir infraestrutura dedicada (ex.: serviço gerenciado de WebSocket).
- O operador passar a precisar de funcionamento offline real (fila local de transições com sincronização)
  — o que muda o modelo de "tempo real" para "sincronização eventual" e exige resolução de conflito.
- Web Push maduro no iOS tornar o painel administrativo elegível a push sem app nativo.
