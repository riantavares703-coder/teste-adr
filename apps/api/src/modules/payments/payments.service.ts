import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';

import { and, desc, eq } from 'drizzle-orm';
import { canTransitionPayment, maskPixKey, type PaymentMethod } from '@plataforma/domain';
import { Database, type Db } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { conflict, notFound, unprocessable } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../notifications/outbox.service.js';
import { CryptoService } from './crypto.service.js';
import { ManualPixProvider, OnSitePaymentProvider, type PaymentProvider } from './payment-provider.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

@Injectable()
export class PaymentsService {
  private readonly pixProvider: PaymentProvider = new ManualPixProvider();
  private readonly onSiteProvider: PaymentProvider = new OnSitePaymentProvider();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(BranchAccessService) private readonly branchAccess: BranchAccessService,
  ) {}

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
      pixKey = this.crypto.decrypt(Buffer.from(config.keyEncrypted));
      merchantName = config.merchantName;
      merchantCity = config.merchantCity;
      keyLast4 = config.keyLast4;
    }

    const provider = input.method === 'PIX' ? this.pixProvider : this.onSiteProvider;
    const charge = await provider.createCharge({
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      amountCents: input.amountCents,
      pixKey,
      merchantName,
      merchantCity,
    });

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

      const now = new Date();
      await tx
        .update(s.payments)
        .set({
          status: 'CONFIRMED',
          confirmedBy: principal.userId,
          confirmedAt: now,
          confirmedIp: options.ip ?? null,
          confirmationNote: options.note ?? null,
        })
        .where(eq(s.payments.id, paymentId));

      await this.audit.record(tx, {
        principal,
        organizationId: payment.organizationId,
        branchId,
        action: 'payment.confirmed_manually',
        resourceType: 'payment',
        resourceId: paymentId,
        ip: options.ip,
        metadata: {
          orderId: payment.orderId,
          amountCents: payment.amountCents,
          method: payment.method,
          note: options.note ?? null,
        },
      });

      await this.outbox.publish(tx, {
        organizationId: payment.organizationId,
        branchId,
        aggregateType: 'payment',
        aggregateId: paymentId,
        eventType: 'payment.confirmed',
        payload: { orderId: payment.orderId, paymentId, amountCents: payment.amountCents },
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
        // Comunicação honesta ao cliente: nenhum provedor confirma sozinho hoje.
        automaticConfirmation: false,
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
        };
      }
      return {
        configured: true,
        keyType: config.keyType,
        keyMasked: `•••${config.keyLast4}`,
        merchantName: config.merchantName,
        merchantCity: config.merchantCity,
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
    },
  ): Promise<{ keyMasked: string }> {
    await this.branchAccess.assertAccess(principal, branchId);

    return this.db.withTenant(toTenantContext(principal), async (tx) => {
      const branchRows = await tx
        .select({ organizationId: s.branches.organizationId })
        .from(s.branches)
        .where(eq(s.branches.id, branchId))
        .limit(1);
      const branch = branchRows[0];
      if (!branch) throw notFound();

      const trimmed = input.key.trim();
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
        metadata: { keyType: input.keyType, keyChanged: changed, keyLast4: last4 },
      });

      return { keyMasked: maskPixKey(trimmed) };
    });
  }
}
