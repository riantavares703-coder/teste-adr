# ADR-0008 — Pix manual com BR Code EMV atrás de `PaymentProvider`

**Status:** Aceito · **Data:** 2026-08 · **Decisores:** Arquitetura, Produto

---

## Contexto

O briefing é preciso: o estabelecimento cadastra sua chave Pix; o app mostra chave, identificação, valor,
botão de copiar e instruções. E então:

> *"Não assumir que copiar a chave Pix significa que o pagamento foi confirmado. O sistema deverá possuir
> uma arquitetura preparada para futuramente integrar um provedor de pagamentos/Pix com confirmação
> automática. Até existir integração bancária/gateway, o operador poderá confirmar manualmente."*

São dois requisitos distintos: **um comportamento hoje** e **uma capacidade de evolução amanhã**.

## Alternativas de exibição do Pix

**A. Exibir a chave em texto com botão de copiar** (literal do briefing)
Funciona, custo zero. Problema operacional: o cliente cola a chave e **digita o valor à mão**. Digitar
`48,90` como `4,89` ou `489,00` é comum — e cada erro vira uma divergência que alguém precisa resolver
manualmente, justamente no processo que já é manual.

**B. BR Code EMV estático gerado localmente** (escolhida)
O padrão Pix (EMV® QR Code) permite montar localmente um "Copia e Cola" **já com valor e identificação
embutidos**, a partir de dados que já temos: chave, nome do recebedor, cidade e valor. É formatação
padronizada (campos TLV + CRC16), **não** integração: nenhum banco, nenhum contrato, nenhum custo.

**C. Cobrança dinâmica via PSP**
Melhor solução, com confirmação automática — mas exige contrato com PSP, que não existe na Fase 1
(restrição C2).

## Decisão

### Hoje (Fase 1)

**BR Code EMV estático gerado pelo servidor** + **confirmação manual auditada**.

O app mostra QR Code, "Copia e Cola", chave mascarada (`•••1234`), nome do estabelecimento, valor,
instruções e cronômetro da reserva. A tela diz, sem ambiguidade: *"Após pagar, aguarde a confirmação da
loja."*

**O comportamento exigido não muda:** copiar ou pagar **não confirma nada**. O BR Code estático não gera
notificação de recebimento. A confirmação continua sendo um ato do operador, exatamente como o briefing
determina — só que sobre um valor que o cliente não teve chance de digitar errado.

### Amanhã (Fase 2)

Tudo atrás de uma porta:

```typescript
interface PaymentProvider {
  readonly code: string;
  readonly supportsAutomaticConfirmation: boolean;
  createCharge(...): Promise<ChargeResult>;
  confirm(...): Promise<PaymentResult>;
  refund(...): Promise<RefundResult>;
  parseWebhook?(raw: Buffer, signature: string): PaymentEvent[];
}
```

`ManualPixProvider` e `OnSiteProvider` hoje; `PspPixProvider` amanhã. A tabela `payments` já nasce
agnóstica (`provider`, `provider_payment_id`, `pix_txid`, `payment_events`).

**O que a Fase 2 não muda:** `orders`, `order_items`, `order_status_history`, a máquina de estados do
pedido, o fluxo de estoque e os aplicativos. Entra um adapter e uma configuração. Esse é o teste de que a
fronteira está no lugar certo.

### Controles da confirmação manual

Permissão `payment:confirm`; valor lido de `orders.total_cents` (nunca da requisição); `confirmed_by` +
`confirmed_ip` + `confirmed_at` + `audit_logs`; idempotência (`409` se já confirmado); alerta em
confirmação fora do horário; relatório diário de conciliação; reversão apenas por `UNIT_MANAGER`+ com
motivo, sem apagar o registro anterior.

## Consequências

**Positivas**
- Requisito atendido literalmente, com UX substancialmente melhor e custo zero.
- Erro de digitação de valor eliminado — reduz a divergência na conciliação, que é o ponto fraco do
  processo manual.
- Migrar para PSP é escrever um adapter, sem tocar em pedido, estoque ou apps.
- Toda confirmação é rastreável a uma pessoa, um IP e um horário.

**Negativas — assumidas conscientemente**
- **Fraude interna do operador não é eliminada**, apenas tornada detectável (registrada como risco aceito
  em [`09` §5](../09-ameacas-e-mitigacoes.md)). Só a integração com PSP resolve.
- Confirmação manual é trabalho humano recorrente e fonte de atraso no pedido.
- O lojista precisa acompanhar o app do banco em paralelo.
- Gerar BR Code exige implementar EMV/TLV + CRC16 corretamente e **validar nos apps dos principais
  bancos** — é o item de maior risco de execução da Fase 5, e por isso está explícito no critério de
  aceite.
- Chave Pix estática exposta no app permite pagamentos não solicitados (sem prejuízo direto, mas gera
  ruído na conciliação).

## Revisitar quando

- Houver contrato com PSP → `PspPixProvider` com webhook assinado; a confirmação manual permanece como
  contingência para quando o PSP estiver fora do ar.
- O volume de confirmações manuais tornar o custo operacional maior que a taxa do PSP — este é o gatilho
  econômico, e deve ser medido desde a Fase 5.
- O Banco Central alterar o padrão do BR Code.
