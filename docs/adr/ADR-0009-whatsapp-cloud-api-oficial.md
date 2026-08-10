# ADR-0009 — Exclusivamente a WhatsApp Business Platform oficial

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Produto, Jurídico

---

## Contexto

O briefing determina: *"Não utilizar automações não oficiais que possam provocar bloqueio da conta.
Estruturar a integração pensando na WhatsApp Business Platform/API oficial."*

A decisão já vem tomada, mas registrá-la importa: a tentação técnica é real e recorrente. Bibliotecas como
`whatsapp-web.js` e `Baileys` funcionam, são gratuitas, instalam em minutos e dispensam aprovação de
templates. Em algum momento alguém proporá usá-las "só no MVP" — e este ADR é a resposta.

## Alternativas

| | **Cloud API oficial** | Baileys / whatsapp-web.js | Twilio / 360dialog (BSP) |
|---|---|---|---|
| Situação | Oficial, contratual | **Viola os Termos de Serviço** | Oficial, revendedor |
| Risco à conta | Nenhum | **Banimento permanente do número** | Nenhum |
| Estabilidade | SLA, versionamento | Quebra a cada atualização do WhatsApp Web | SLA |
| Escala | Milhares de msg/s | Uma sessão por número, frágil | Alta |
| Templates | Aprovação prévia | Não exige | Aprovação prévia |
| Webhooks de entrega | Sim | Não | Sim |
| Custo | Por conversa | "Grátis" | Por conversa + margem |
| Setup | WABA + verificação da empresa | Escanear QR Code | Simplificado |

O argumento decisivo não é técnico: **o número banido é do lojista, não nosso.** Ele perde o canal
principal de contato com os clientes dele — muitas vezes o ativo mais valioso de um pequeno negócio. Não
temos o direito de assumir esse risco em nome de terceiros para economizar taxa de conversa.

O segundo argumento é de sustentabilidade: automação não oficial depende de engenharia reversa do
WhatsApp Web. Cada atualização do WhatsApp pode quebrar a integração, sem aviso e sem recurso. Construir
a comunicação do produto sobre isso é construir sobre areia.

## Decisão

**Exclusivamente a WhatsApp Business Platform (Cloud API) da Meta**, atrás da porta `WhatsAppService`
com adapters `MetaCloudApiAdapter`, `TwilioAdapter` (BSP alternativo) e `NoopAdapter` (desenvolvimento e
testes).

Consequências de projeto que decorrem das regras da plataforma:

1. **Janela de 24 h** — mensagem de texto livre só dentro de 24 h da última mensagem do cliente. Como
   notificação de status é iniciada pelo negócio, **todo o fluxo usa templates aprovados**.
2. **Templates com aprovação prévia** — o mapeamento evento → template fica em
   `whatsapp_integrations.template_map`, configurável por organização. Aprovação da Meta **nunca** pode
   estar no caminho de um deploy.
3. **Opt-in comprovável** — `customer_organization_links.whatsapp_opt_in` com data e origem. Sem opt-in,
   a notificação é marcada `SKIPPED` e o cliente recebe por push.
4. **Opt-out imediato** — "PARAR"/"SAIR" desliga o envio na hora. Exigência da plataforma e da LGPD.
5. **Token fora do banco** — `access_token_secret_ref` guarda uma referência ao secret manager. Um dump do
   banco não entrega o WhatsApp de nenhum lojista.

## Consequências

**Positivas**
- Zero risco de banimento para o lojista.
- Webhooks de `sent`/`delivered`/`read`/`failed` dão observabilidade real da comunicação.
- Escala e SLA compatíveis com múltiplas franquias.
- Conformidade contratual e com a LGPD.
- Trocar de BSP é escrever um adapter.

**Negativas — assumidas conscientemente**
- **Custo por conversa.** Mitigado por orçamento por organização, deduplicação, agregação de rajadas e
  fallback para push ao atingir o teto.
- **Onboarding mais pesado**: o lojista precisa de WABA, verificação da empresa e número dedicado. É
  atrito comercial real na aquisição, e precisa de material de apoio.
- **Templates exigem aprovação** — mudar o texto de uma mensagem leva de minutos a dias. Por isso o
  mapeamento é configuração, não código.
- **Dependência de terceiro** com política que pode mudar unilateralmente. Mitigado pela porta e pelo
  fallback para push, que garante que nenhuma informação essencial dependa só do WhatsApp.
- Queda na avaliação de qualidade (bloqueios pelos clientes) reduz o limite de envio — monitorado, com
  corte automático da franquia problemática.

## Revisitar quando

- A Meta alterar substancialmente preço ou política — comparar BSPs, sem mudar a arquitetura.
- Um mercado exigir outro canal dominante (Telegram, RCS) — entra como novo adapter da mesma porta.
- Nunca para reconsiderar automação não oficial. Esta parte da decisão é definitiva.
