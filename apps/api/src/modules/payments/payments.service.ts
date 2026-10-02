import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';

import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import {
  canTransitionPayment,
  maskPixKey,
  normalizePixKey,
  PixBrCodeError,
  type PaymentMethod,
  type PixKeyType,
} from '@plataforma/domain';
import { Database, type Db } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { conflict, notFound, unprocessable } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../notifications/outbox.service.js';
import { CryptoService } from './crypto.service.js';
import {
  fetchMercadoPagoPayment,
  ManualPixProvider,
  MercadoPagoError,
  MercadoPagoPixProvider,
  OnSitePaymentProvider,
  verifyMercadoPagoToken,
  type PaymentProvider,
} from './payment-provider.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');
  private readonly pixProvider: PaymentProvider = new ManualPixProvider();
  private readonly mercadoPagoProvider: PaymentProvider = new MercadoPagoPixProvider();
  private readonly onSiteProvider: PaymentProvider = new OnSitePaymentProvider();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(BranchAccessService) private readonly branchAccess: BranchAccessService,
  ) {}

  private canonicalKey(type: PixKeyType, raw: string): string {
    try {
      return normalizePixKey(type, raw);
    } catch (err) {
      if (err instanceof PixBrCodeError) throw unprocessable('CHAVE_PIX_INVALIDA', err.message);
      throw err;
    }
  }

  /** Cria o pagamento junto com o pedido, na mesma transação. */
  async createForOrder(
    tx: Db,
    input: {
      orderId: string;
      organizationId: string;
      branchId: string;
      method: PaymentMethod;
      amountCents: number;
      orderNumber: string;
    },
  ): Promise<void> {
    let pixKey: string | undefined;
    let merchantName: string | undefined;
    let merchantCity: string | undefined;
    let keyLast4: string | null = null;
    let accessToken: string | undefined;

    if (input.method === 'PIX') {
      const rows = await tx
        .select()
        .from(s.pixSettings)
        .where(and(eq(s.pixSettings.branchId, input.branchId), eq(s.pixSettings.isActive, true)))
        .limit(1);

      const config = rows[0];
      // isDemoSeed: a linha existe (o seed grava uma), mas é a chave de
      // mentira do restaurante de demonstração — tratar exatamente como "não
      // configurado" é o que impede um cliente real de receber um QR Code
      // apontando para uma chave que não existe em banco nenhum.
      if (!config || config.isDemoSeed) {
        throw unprocessable(
          'PIX_NAO_CONFIGURADO',
          'Esta unidade ainda não configurou a chave Pix',
        );
      }
      // Decifra apenas no momento de gerar o BR Code. Toda decifragem é auditada.
      // Linhas gravadas antes da normalização podem ter a chave como foi digitada.
      pixKey = this.canonicalKey(config.keyType as PixKeyType, this.crypto.decrypt(Buffer.from(config.keyEncrypted)));
      merchantName = config.merchantName;
      merchantCity = config.merchantCity;
      keyLast4 = config.keyLast4;
      if (config.mpAccessTokenEncrypted) {
        accessToken = this.crypto.decrypt(Buffer.from(config.mpAccessTokenEncrypted));
      }
    }

    const chargeInput = {
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      amountCents: input.amountCents,
      pixKey,
      merchantName,
      merchantCity,
      accessToken,
    };

    let charge;
    if (input.method !== 'PIX') {
      charge = await this.onSiteProvider.createCharge(chargeInput);
    } else if (accessToken) {
      try {
        charge = await this.mercadoPagoProvider.createCharge(chargeInput);
      } catch (err) {
        // Mercado Pago fora do ar não pode impedir a loja de vender: cai para o
        // BR Code estático com a chave da loja. O cliente paga do mesmo jeito;
        // só a confirmação volta a ser manual (provider = MANUAL_PIX deixa isso explícito).
        if (!(err instanceof MercadoPagoError)) throw err;
        this.logger.warn(`Mercado Pago falhou (${err.message}); usando Pix estático`);
        charge = await this.pixProvider.createCharge(chargeInput);
      }
    } else {
      charge = await this.pixProvider.createCharge(chargeInput);
    }

    await tx.insert(s.payments).values({
      id: uuidv7(),
      organizationId: input.organizationId,
      branchId: input.branchId,
      orderId: input.orderId,
      method: input.method,
      status: charge.status,
      amountCents: input.amountCents,
      provider: charge.provider,
      providerPaymentId: charge.providerPaymentId,
      pixBrcode: charge.pixBrcode,
      pixTxid: charge.pixTxid,
      pixKeyLast4: keyLast4,
    } as never);
  }

  /**
   * Confirmação manual do recebimento (item 7 do Prompt 02).
   *
   * O valor NUNCA vem da requisição: é lido de `orders.total_cents`. Quem
   * confirma, de qual IP e quando ficam registrados de forma imutável — é o que
   * torna a fraude interna detectável enquanto não houver PSP.
   */
  async confirmManually(
    principal: Principal,
    branchId: string,
    paymentId: string,
    options: { note?: string; ip?: string } = {},
  ): Promise<{ paymentStatus: string; orderStatus: string }> {
    await this.branchAccess.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.payments)
        .where(and(eq(s.payments.id, paymentId), eq(s.payments.branchId, branchId)))
        // Trava a linha: duas confirmações simultâneas viram uma só (a outra
        // espera, relê o status já CONFIRMED e recebe 409).
        .for('update')
        .limit(1);

      const payment = rows[0];
      if (!payment) throw notFound();

      const check = canTransitionPayment({
        from: payment.status,
        to: 'CONFIRMED',
        actorType: 'STAFF',
      });
      if (!check.allowed) {
        throw conflict(check.code, check.message, { from: payment.status });
      }

      await this.applyConfirmation(tx, payment, {
        principal,
        actorType: 'STAFF',
        ip: options.ip,
        note: options.note,
        action: 'payment.confirmed_manually',
      });

      const orderRows = await tx
        .select({ status: s.orders.status })
        .from(s.orders)
        .where(eq(s.orders.id, payment.orderId))
        .limit(1);

      return {
        paymentStatus: 'CONFIRMED',
        // As duas máquinas são independentes: confirmar pagamento NÃO avança o
        // pedido sozinho. O operador aceita o pedido em uma ação separada.
        orderStatus: orderRows[0]?.status ?? 'PENDING',
      };
    });
  }

  /** Grava a confirmação, audita e notifica. Compartilhado entre operador e conciliação automática. */
  private async applyConfirmation(
    tx: Db,
    payment: typeof s.payments.$inferSelect,
    by: {
      principal?: Principal;
      actorType: 'STAFF' | 'WEBHOOK';
      ip?: string;
      note?: string;
      action: string;
    },
  ): Promise<void> {
    await tx
      .update(s.payments)
      .set({
        status: 'CONFIRMED',
        confirmedBy: by.principal?.userId ?? null,
        confirmedAt: new Date(),
        confirmedIp: by.ip ?? null,
        confirmationNote: by.note ?? null,
      })
      .where(eq(s.payments.id, payment.id));

    await this.audit.record(tx, {
      principal: by.principal ?? null,
      organizationId: payment.organizationId,
      branchId: payment.branchId,
      action: by.action,
      resourceType: 'payment',
      resourceId: payment.id,
      ip: by.ip,
      metadata: {
        orderId: payment.orderId,
        amountCents: payment.amountCents,
        method: payment.method,
        provider: payment.provider,
        providerPaymentId: payment.providerPaymentId,
        note: by.note ?? null,
      },
    });

    await this.outbox.publish(tx, {
      organizationId: payment.organizationId,
      branchId: payment.branchId,
      aggregateType: 'payment',
      aggregateId: payment.id,
      eventType: 'payment.confirmed',
      payload: { orderId: payment.orderId, paymentId: payment.id, amountCents: payment.amountCents },
    });
  }

  /**
   * Conciliação automática: pergunta ao Mercado Pago pelos Pix em aberto.
   *
   * É consulta (polling), não webhook, de propósito: o sistema roda no
   * computador da loja, que o Mercado Pago não alcança. Só precisa de internet
   * de saída.
   *
   * O valor e a referência do pagamento são conferidos contra o NOSSO pedido
   * antes de confirmar — a resposta do provedor nunca é a fonte do valor.
   */
  async reconcileMercadoPago(): Promise<number> {
    const since = new Date(Date.now() - 6 * 60 * 60_000);
    const open = await this.db.withPlatform(async (tx) => {
      const rows = await tx
        .select({
          payment: s.payments,
          tokenEncrypted: s.pixSettings.mpAccessTokenEncrypted,
        })
        .from(s.payments)
        .innerJoin(s.pixSettings, eq(s.pixSettings.branchId, s.payments.branchId))
        .where(
          and(
            eq(s.payments.provider, 'MERCADO_PAGO'),
            or(
              and(eq(s.payments.status, 'AWAITING_CONFIRMATION'), gt(s.payments.createdAt, since)),
              // Cobrança cancelada que ainda pode receber um Pix tardio (QR continua válido no banco).
              and(
                eq(s.payments.status, 'CANCELLED'),
                isNull(s.payments.failureReason),
                gt(s.payments.createdAt, new Date(Date.now() - 2 * 60 * 60_000)),
              ),
            ),
          ),
        )
        .orderBy(s.payments.createdAt)
        .limit(50);
      return rows;
    });

    let confirmed = 0;
    for (const { payment, tokenEncrypted } of open) {
      if (!tokenEncrypted || !payment.providerPaymentId) continue;
      try {
        const token = this.crypto.decrypt(Buffer.from(tokenEncrypted));
        const remote = await fetchMercadoPagoPayment(token, payment.providerPaymentId);
        if (remote.status === 'approved' && payment.status === 'CANCELLED') {
          await this.flagLatePayment(payment.id, remote.amountCents);
        } else if (remote.status === 'approved') {
          if (await this.confirmFromProvider(payment.id, remote)) confirmed += 1;
        } else if (remote.status === 'rejected' || remote.status === 'cancelled') {
          await this.failFromProvider(payment.id, `Mercado Pago: ${remote.status}`);
        }
      } catch (err) {
        // Um pagamento com erro não pode travar os demais; a próxima rodada tenta de novo.
        this.logger.warn(`Conciliação do pagamento ${payment.id} falhou: ${(err as Error).message}`);
      }
    }
    return confirmed;
  }

  private async confirmFromProvider(
    paymentId: string,
    remote: { id: string; amountCents: number; externalReference: string | null },
  ): Promise<boolean> {
    return this.db.withPlatform(async (tx) => {
      const rows = await tx
        .select()
        .from(s.payments)
        .where(and(eq(s.payments.id, paymentId), eq(s.payments.status, 'AWAITING_CONFIRMATION')))
        .for('update')
        .limit(1);
      const payment = rows[0];
      if (!payment) return false;

      if (remote.amountCents !== payment.amountCents || remote.externalReference !== payment.orderId) {
        // Aprovado, mas não bate com o pedido: NÃO confirma e deixa rastro para a loja investigar.
        await this.audit.record(tx, {
          organizationId: payment.organizationId,
          branchId: payment.branchId,
          action: 'payment.provider_mismatch',
          resourceType: 'payment',
          resourceId: payment.id,
          result: 'FAILURE',
          metadata: {
            expectedCents: payment.amountCents,
            receivedCents: remote.amountCents,
            referenceMatches: remote.externalReference === payment.orderId,
          },
        });
        this.logger.error(`Pagamento ${payment.id}: valor/referência do Mercado Pago não conferem`);
        return false;
      }

      const check = canTransitionPayment({ from: payment.status, to: 'CONFIRMED', actorType: 'WEBHOOK' });
      if (!check.allowed) return false;

      await this.applyConfirmation(tx, payment, {
        actorType: 'WEBHOOK',
        note: `Confirmado automaticamente pelo Mercado Pago (pagamento ${remote.id})`,
        action: 'payment.confirmed_by_provider',
      });
      return true;
    });
  }

  /** Pix pago DEPOIS do cancelamento: não confirma nada, mas a loja precisa saber que há dinheiro a estornar. */
  private async flagLatePayment(paymentId: string, receivedCents: number): Promise<void> {
    await this.db.withPlatform(async (tx) => {
      const [payment] = await tx
        .select()
        .from(s.payments)
        .where(and(eq(s.payments.id, paymentId), eq(s.payments.status, 'CANCELLED'), isNull(s.payments.failureReason)))
        .for('update')
        .limit(1);
      if (!payment) return;
      await tx
        .update(s.payments)
        .set({ failureReason: 'Pago após o cancelamento do pedido: estornar no Mercado Pago' })
        .where(eq(s.payments.id, paymentId));
      await this.audit.record(tx, {
        organizationId: payment.organizationId,
        branchId: payment.branchId,
        action: 'payment.received_after_cancel',
        resourceType: 'payment',
        resourceId: payment.id,
        result: 'FAILURE',
        metadata: { orderId: payment.orderId, amountCents: receivedCents },
      });
      this.logger.error(`Pagamento ${payment.id} recebido após o cancelamento do pedido: estornar ${receivedCents} centavos`);
    });
  }

  private async failFromProvider(paymentId: string, reason: string): Promise<void> {
    await this.db.withPlatform(async (tx) => {
      await tx
        .update(s.payments)
        .set({ status: 'FAILED', failureReason: reason })
        .where(and(eq(s.payments.id, paymentId), eq(s.payments.status, 'AWAITING_CONFIRMATION')));
    });
  }

  /** Dados de pagamento para a tela do cliente. */
  async getPaymentForOrder(principal: Principal, orderId: string) {
    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.payments)
        .where(eq(s.payments.orderId, orderId))
        .orderBy(desc(s.payments.createdAt))
        .limit(1);

      const payment = rows[0];
      if (!payment) throw notFound();

      return {
        id: payment.id,
        method: payment.method,
        status: payment.status,
        amountCents: payment.amountCents,
        pixBrcode: payment.pixBrcode,
        pixKeyMasked: payment.pixKeyLast4 ? `•••${payment.pixKeyLast4}` : null,
        provider: payment.provider,
        // Só o Mercado Pago confirma sozinho; Pix estático e pagamento presencial dependem da loja.
        automaticConfirmation: payment.provider === 'MERCADO_PAGO',
        confirmedAt: payment.confirmedAt,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Configuração da chave Pix
  // ---------------------------------------------------------------------------

  /**
   * Estado atual da chave Pix para a tela de configurações.
   *
   * NUNCA devolve a chave em si — só o suficiente para o operador confirmar
   * "sim, é essa a chave certa" (tipo + últimos 4 dígitos), na mesma máscara
   * usada na tela de pagamento do cliente. Ler aqui não descriptografa nada.
   */
  async getPixSettings(
    principal: Principal,
    branchId: string,
  ): Promise<{
    configured: boolean;
    keyType: string | null;
    keyMasked: string | null;
    merchantName: string | null;
    merchantCity: string | null;
    mercadoPagoConfigured: boolean;
    mercadoPagoTokenMasked: string | null;
  }> {
    await this.branchAccess.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.pixSettings)
        .where(and(eq(s.pixSettings.branchId, branchId), eq(s.pixSettings.isActive, true)))
        .limit(1);

      const config = rows[0];
      // Mesma regra do createForOrder: a chave de demonstração conta como
      // "não configurado" para o operador — é exatamente isso que ele precisa
      // saber para agir (cadastrar a chave de verdade).
      if (!config || config.isDemoSeed) {
        return {
          configured: false,
          keyType: null,
          keyMasked: null,
          merchantName: null,
          merchantCity: null,
          mercadoPagoConfigured: false,
          mercadoPagoTokenMasked: null,
        };
      }
      return {
        configured: true,
        keyType: config.keyType,
        keyMasked: `•••${config.keyLast4}`,
        merchantName: config.merchantName,
        merchantCity: config.merchantCity,
        mercadoPagoConfigured: Boolean(config.mpAccessTokenEncrypted),
        mercadoPagoTokenMasked: config.mpTokenLast4 ? `•••${config.mpTokenLast4}` : null,
      };
    });
  }

  /**
   * Trocar a chave Pix redireciona TODO o dinheiro que entra. É a alteração de
   * maior impacto financeiro do sistema — exige `pix_settings:update`, é
   * auditada e notifica o administrador da franquia.
   */
  async upsertPixSettings(
    principal: Principal,
    branchId: string,
    input: {
      keyType: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'RANDOM';
      key: string;
      merchantName: string;
      merchantCity: string;
      /** undefined = mantém o atual; null = remove; string = troca. */
      mercadoPagoAccessToken?: string | null;
    },
  ): Promise<{ keyMasked: string }> {
    await this.branchAccess.assertAccess(principal, branchId);

    const mpToken = input.mercadoPagoAccessToken?.trim();
    if (mpToken) {
      try {
        await verifyMercadoPagoToken(mpToken);
      } catch (err) {
        if (!(err instanceof MercadoPagoError)) throw err;
        if (err.httpStatus === 401 || err.httpStatus === 403) {
          throw unprocessable(
            'MERCADO_PAGO_TOKEN_INVALIDO',
            'O Mercado Pago recusou este access token.',
          );
        }
        throw unprocessable(
          'MERCADO_PAGO_INDISPONIVEL',
          'Não foi possível validar o token no Mercado Pago agora.',
        );
      }
    }
    const mpPatch =
      input.mercadoPagoAccessToken === undefined
        ? {}
        : mpToken
          ? { mpAccessTokenEncrypted: this.crypto.encrypt(mpToken), mpTokenLast4: mpToken.slice(-4) }
          : { mpAccessTokenEncrypted: null, mpTokenLast4: null };

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const branchRows = await tx
        .select({ organizationId: s.branches.organizationId })
        .from(s.branches)
        .where(eq(s.branches.id, branchId))
        .limit(1);
      const branch = branchRows[0];
      if (!branch) throw notFound();

      const trimmed = this.canonicalKey(input.keyType, input.key);
      const encrypted = this.crypto.encrypt(trimmed);
      const fingerprint = this.crypto.fingerprint(trimmed);
      const last4 = trimmed.slice(-4);

      const existing = await tx
        .select({ fingerprint: s.pixSettings.keyFingerprint })
        .from(s.pixSettings)
        .where(eq(s.pixSettings.branchId, branchId))
        .limit(1);

      const changed =
        !existing[0] || !Buffer.from(existing[0].fingerprint).equals(fingerprint);

      if (existing[0]) {
        await tx
          .update(s.pixSettings)
          .set({
            keyType: input.keyType,
            keyEncrypted: encrypted,
            keyLast4: last4,
            keyFingerprint: fingerprint,
            merchantName: input.merchantName.slice(0, 25),
            merchantCity: input.merchantCity.slice(0, 15),
            isActive: true,
            // Um salvamento real pelo lojista sempre substitui a chave de
            // demonstração, mesmo que a linha tenha nascido do seed.
            isDemoSeed: false,
            ...mpPatch,
            updatedBy: principal.userId,
          } as never)
          .where(eq(s.pixSettings.branchId, branchId));
      } else {
        await tx.insert(s.pixSettings).values({
          branchId,
          organizationId: branch.organizationId,
          keyType: input.keyType,
          keyEncrypted: encrypted,
          keyLast4: last4,
          keyFingerprint: fingerprint,
          merchantName: input.merchantName.slice(0, 25),
          merchantCity: input.merchantCity.slice(0, 15),
          ...mpPatch,
          updatedBy: principal.userId,
        } as never);
      }

      await this.audit.record(tx, {
        principal,
        organizationId: branch.organizationId,
        branchId,
        action: 'pix_settings.updated',
        resourceType: 'pix_settings',
        resourceId: branchId,
        // A chave NUNCA entra na auditoria — só o fato de ter mudado.
        metadata: {
          keyType: input.keyType,
          keyChanged: changed,
          keyLast4: last4,
          mercadoPagoChanged: input.mercadoPagoAccessToken !== undefined,
        },
      });

      return { keyMasked: maskPixKey(trimmed) };
    });
  }
}
