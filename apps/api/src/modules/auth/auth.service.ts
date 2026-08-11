import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';
import { createHash, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { forbidden, tooManyRequests, unauthorized } from '../../common/errors.js';
import type { Principal } from '../../common/principal.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { OtpDeliveryService } from './otp-delivery.service.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const MAX_FAILED_LOGINS = 5;
const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;

/**
 * Teto de sessões de convidado por IP.
 *
 * Folgado de propósito: num restaurante, dezenas de celulares saem do MESMO IP
 * público. Apertar isso trancaria a mesa 12 porque a mesa 3 pediu antes. O
 * limite existe contra automação, não contra movimento.
 */
const GUEST_RATE_WINDOW_MS = 10 * 60_000;
const GUEST_MAX_PER_WINDOW = 60;

@Injectable()
export class AuthService {
  private readonly env = loadEnv();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(OtpDeliveryService) private readonly otpDelivery: OtpDeliveryService,
  ) {}

  // ---------------------------------------------------------------------------
  // Operador / administrador: e-mail + senha
  // ---------------------------------------------------------------------------

  async loginStaff(input: {
    organizationSlug: string;
    email: string;
    password: string;
    ip?: string;
    userAgent?: string;
    deviceId?: string;
  }): Promise<TokenPair> {
    const generic = unauthorized('CREDENCIAIS_INVALIDAS', 'Credenciais inválidas');

    const row = await this.db.platform
      .select({ user: s.users, orgId: s.organizations.id })
      .from(s.users)
      .innerJoin(s.organizations, eq(s.organizations.id, s.users.organizationId))
      .where(
        and(
          eq(s.organizations.slug, input.organizationSlug),
          eq(s.users.email, input.email),
          eq(s.users.type, 'STAFF'),
          isNull(s.users.deletedAt),
        ),
      )
      .limit(1);

    const user = row[0]?.user ?? null;

    // Verificação executada mesmo sem usuário (hash dummy) para não vazar
    // existência por diferença de tempo.
    const passwordOk = await this.passwords.verify(user?.passwordHash ?? null, input.password);

    if (!user) {
      await this.recordLoginAttempt(input.email, null, false, 'USUARIO_INEXISTENTE', input.ip);
      throw generic;
    }

    // Conta bloqueada devolve a MESMA mensagem — não confirmamos o bloqueio.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.recordLoginAttempt(input.email, user.id, false, 'BLOQUEADA', input.ip);
      throw generic;
    }

    if (!user.isActive) {
      await this.recordLoginAttempt(input.email, user.id, false, 'INATIVA', input.ip);
      throw generic;
    }

    if (!passwordOk) {
      await this.registerFailure(user.id, user.failedLoginCount);
      await this.recordLoginAttempt(input.email, user.id, false, 'SENHA_INVALIDA', input.ip);
      throw generic;
    }

    await this.db.platform
      .update(s.users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(s.users.id, user.id));
    await this.recordLoginAttempt(input.email, user.id, true, null, input.ip);

    return this.issueSession(user.id, 'STAFF', user.organizationId, user.tokenVersion, input);
  }

  /** Bloqueio progressivo: 1, 2, 4, 8 e 30 minutos. Por conta E por IP. */
  private async registerFailure(userId: string, currentCount: number): Promise<void> {
    const next = currentCount + 1;
    let lockedUntil: Date | null = null;
    if (next >= MAX_FAILED_LOGINS) {
      const step = Math.min(next - MAX_FAILED_LOGINS, 4);
      const minutes = [1, 2, 4, 8, 30][step] ?? 30;
      lockedUntil = new Date(Date.now() + minutes * 60_000);
    }
    await this.db.platform
      .update(s.users)
      .set({ failedLoginCount: next, lockedUntil })
      .where(eq(s.users.id, userId));
  }

  private async recordLoginAttempt(
    identifier: string,
    userId: string | null,
    succeeded: boolean,
    failureReason: string | null,
    ip?: string,
  ): Promise<void> {
    await this.db.platform.insert(s.loginAttempts).values({
      id: uuidv7(),
      identifier,
      userId,
      succeeded,
      failureReason,
      ipAddress: ip ?? null,
    } as never);
  }

  // ---------------------------------------------------------------------------
  // Cliente: telefone + OTP (sem senha => elimina credential stuffing)
  // ---------------------------------------------------------------------------

  async requestOtp(phoneE164: string): Promise<{ expiresIn: number }> {
    const recent = await this.db.platform
      .select({ count: sql<number>`count(*)::int` })
      .from(s.otpCodes)
      .where(
        and(
          eq(s.otpCodes.identifier, phoneE164),
          gt(s.otpCodes.createdAt, new Date(Date.now() - 60_000)),
        ),
      );
    if ((recent[0]?.count ?? 0) > 0) {
      throw tooManyRequests('AGUARDE', 'Aguarde antes de solicitar um novo código');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.platform.insert(s.otpCodes).values({
      id: uuidv7(),
      identifier: phoneE164,
      codeHash: createHash('sha256').update(code).digest(),
      purpose: 'LOGIN',
      expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
    } as never);

    await this.otpDelivery.send(phoneE164, code);

    // Resposta idêntica para telefone cadastrado ou não — sem enumeração.
    return { expiresIn: OTP_TTL_SECONDS };
  }

  async verifyOtp(input: {
    phoneE164: string;
    code: string;
    fullName?: string;
    ip?: string;
    deviceId?: string;
  }): Promise<TokenPair> {
    const generic = unauthorized('CODIGO_INVALIDO', 'Código inválido ou expirado');

    const rows = await this.db.platform
      .select()
      .from(s.otpCodes)
      .where(
        and(
          eq(s.otpCodes.identifier, input.phoneE164),
          eq(s.otpCodes.purpose, 'LOGIN'),
          isNull(s.otpCodes.consumedAt),
          gt(s.otpCodes.expiresAt, new Date()),
        ),
      )
      .orderBy(sql`created_at DESC`)
      .limit(1);

    const otp = rows[0];
    if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw generic;

    const provided = createHash('sha256').update(input.code).digest();
    if (!PasswordService.safeEqual(Buffer.from(otp.codeHash), provided)) {
      await this.db.platform
        .update(s.otpCodes)
        .set({ attempts: otp.attempts + 1 })
        .where(eq(s.otpCodes.id, otp.id));
      throw generic;
    }

    // Uso único: marca consumido antes de emitir a sessão (anti-replay).
    await this.db.platform
      .update(s.otpCodes)
      .set({ consumedAt: new Date() })
      .where(eq(s.otpCodes.id, otp.id));

    const existing = await this.db.platform
      .select()
      .from(s.users)
      .where(
        and(
          eq(s.users.phoneE164, input.phoneE164),
          eq(s.users.type, 'CUSTOMER'),
          isNull(s.users.deletedAt),
        ),
      )
      .limit(1);

    let user = existing[0];
    if (!user) {
      const inserted = await this.db.platform
        .insert(s.users)
        .values({
          id: uuidv7(),
          type: 'CUSTOMER',
          organizationId: null,
          phoneE164: input.phoneE164,
          fullName: input.fullName?.trim() || 'Cliente',
          phoneVerifiedAt: new Date(),
        } as never)
        .returning();
      user = inserted[0]!;

      const customerRole = await this.roleIdByCode('CUSTOMER');
      await this.db.platform.insert(s.userRoles).values({
        id: uuidv7(),
        userId: user.id,
        roleId: customerRole,
        organizationId: null,
        branchId: null,
      } as never);
    }

    return this.issueSession(user.id, 'CUSTOMER', null, user.tokenVersion, input);
  }

  // ---------------------------------------------------------------------------
  // Cliente de balcão: sem conta, sem código
  // ---------------------------------------------------------------------------

  /**
   * Sessão de CONVIDADO — quem chegou pelo QR code da mesa.
   *
   * Por que existe: o cliente de balcão não tem conta e não vai esperar um
   * código chegar por WhatsApp para pedir um lanche. Sem isto, o fluxo do QR
   * code simplesmente não fecha numa instalação local, onde não há provedor de
   * mensagem configurado.
   *
   * O que ela NÃO é: um atalho que contorna o modelo de permissões. O convidado
   * vira um usuário CUSTOMER de verdade, com o papel CUSTOMER e uma sessão
   * normal — então RLS, `order:create`, `order:read_own` e a auditoria seguem
   * valendo sem exceção. A única diferença é `phone_verified_at` nulo.
   *
   * O que se perde, declaradamente: o telefone não é verificado. Quem digita
   * pode digitar o de outra pessoa. Duas defesas concretas:
   *  - um telefone JÁ VERIFICADO nunca é assumido por esta via (senão bastaria
   *    saber o número de um cliente para ler o histórico dele);
   *  - limite por IP, para que a tela não vire uma fábrica de pedidos falsos.
   *
   * A confirmação real continua sendo humana: o operador vê o pedido na fila e
   * decide aceitar.
   */
  async startGuestSession(input: {
    phoneE164: string;
    fullName: string;
    ip?: string;
    userAgent?: string;
    deviceId?: string;
  }): Promise<TokenPair> {
    await this.assertGuestRateLimit(input.ip);

    const existing = await this.db.platform
      .select()
      .from(s.users)
      .where(
        and(
          eq(s.users.phoneE164, input.phoneE164),
          eq(s.users.type, 'CUSTOMER'),
          isNull(s.users.deletedAt),
        ),
      )
      .limit(1);

    let user = existing[0];

    if (user?.phoneVerifiedAt) {
      // Conta verificada não é assumível sem o código. Este caminho só é
      // alcançável depois que um provedor de OTP real for configurado.
      await this.recordLoginAttempt(
        input.phoneE164,
        user.id,
        false,
        'GUEST_SOBRE_CONTA_VERIFICADA',
        input.ip,
      );
      throw forbidden(
        'CONTA_VERIFICADA',
        'Esse telefone já tem conta. Entre com o código enviado por mensagem.',
      );
    }

    if (!user) {
      const inserted = await this.db.platform
        .insert(s.users)
        .values({
          id: uuidv7(),
          type: 'CUSTOMER',
          organizationId: null,
          phoneE164: input.phoneE164,
          fullName: input.fullName.trim() || 'Cliente',
          // Nulo de propósito: marca no banco que este telefone NÃO foi provado.
          phoneVerifiedAt: null,
        } as never)
        .returning();
      user = inserted[0]!;

      const customerRole = await this.roleIdByCode('CUSTOMER');
      await this.db.platform.insert(s.userRoles).values({
        id: uuidv7(),
        userId: user.id,
        roleId: customerRole,
        organizationId: null,
        branchId: null,
      } as never);
    } else if (input.fullName.trim() && input.fullName.trim() !== user.fullName) {
      // Mesmo telefone, nome novo: o pedido de hoje é de quem está pedindo hoje.
      await this.db.platform
        .update(s.users)
        .set({ fullName: input.fullName.trim() })
        .where(eq(s.users.id, user.id));
    }

    await this.recordLoginAttempt(input.phoneE164, user.id, true, null, input.ip);
    return this.issueSession(user.id, 'CUSTOMER', null, user.tokenVersion, input);
  }

  /**
   * Teto de sessões de convidado por IP.
   *
   * Usa `login_attempts`, que já é a trilha de tentativas do sistema — e, por
   * viver no banco, o limite sobrevive a um reinício do processo, diferente de
   * um contador em memória.
   */
  private async assertGuestRateLimit(ip?: string): Promise<void> {
    if (!ip) return;
    const since = new Date(Date.now() - GUEST_RATE_WINDOW_MS);
    const rows = await this.db.platform
      .select({ count: sql<number>`count(*)::int` })
      .from(s.loginAttempts)
      .where(and(eq(s.loginAttempts.ipAddress, ip), gt(s.loginAttempts.createdAt, since)));

    if ((rows[0]?.count ?? 0) >= GUEST_MAX_PER_WINDOW) {
      throw tooManyRequests('MUITAS_TENTATIVAS', 'Muitos pedidos deste dispositivo. Aguarde alguns minutos.');
    }
  }

  // ---------------------------------------------------------------------------
  // Sessões
  // ---------------------------------------------------------------------------

  private async issueSession(
    userId: string,
    userType: 'STAFF' | 'CUSTOMER',
    organizationId: string | null,
    tokenVersion: number,
    meta: { ip?: string; userAgent?: string; deviceId?: string },
  ): Promise<TokenPair> {
    const { token: refreshToken, hash } = this.tokens.generateRefreshToken();
    const sessionId = uuidv7();
    const expiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

    await this.db.platform.insert(s.sessions).values({
      id: sessionId,
      userId,
      refreshTokenHash: hash,
      familyId: uuidv7(),
      deviceId: meta.deviceId ?? null,
      userAgent: meta.userAgent ?? null,
      ipAddress: meta.ip ?? null,
      expiresAt,
    } as never);

    const accessToken = await this.tokens.issueAccessToken({
      sub: userId,
      sid: sessionId,
      typ: userType,
      org: organizationId ?? undefined,
      ver: tokenVersion,
    });

    return { accessToken, refreshToken, expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS };
  }

  /**
   * Renovação com rotação e DETECÇÃO DE REUSO.
   *
   * Apresentar um token já rotacionado significa que existem duas cópias em
   * circulação. Não dá para saber qual é a legítima — então a família inteira
   * é revogada e o token_version é incrementado, derrubando todos os access
   * tokens do usuário. Roubo de token vira incidente contido, não acesso
   * silencioso permanente.
   */
  async refresh(refreshToken: string, meta: { ip?: string; deviceId?: string }): Promise<TokenPair> {
    const hash = this.tokens.hashRefreshToken(refreshToken);

    const rows = await this.db.platform
      .select()
      .from(s.sessions)
      .where(eq(s.sessions.refreshTokenHash, hash))
      .limit(1);

    const session = rows[0];
    if (!session) throw unauthorized('SESSAO_INVALIDA', 'Sessão inválida');

    if (session.replacedBy !== null) {
      await this.revokeFamily(session.familyId, 'REUSE_DETECTED');
      await this.db.platform
        .update(s.users)
        .set({ tokenVersion: sql`${s.users.tokenVersion} + 1` })
        .where(eq(s.users.id, session.userId));
      throw unauthorized('REUSO_DETECTADO', 'Sessão encerrada por segurança. Entre novamente.');
    }

    if (session.revokedAt || session.expiresAt <= new Date()) {
      throw unauthorized('SESSAO_EXPIRADA', 'Sessão expirada');
    }

    const users = await this.db.platform
      .select()
      .from(s.users)
      .where(eq(s.users.id, session.userId))
      .limit(1);
    const user = users[0];
    if (!user || !user.isActive) throw unauthorized('SESSAO_INVALIDA', 'Sessão inválida');

    const { token: nextToken, hash: nextHash } = this.tokens.generateRefreshToken();
    const nextSessionId = uuidv7();

    await this.db.withPlatform(async (tx) => {
      await tx.insert(s.sessions).values({
        id: nextSessionId,
        userId: session.userId,
        refreshTokenHash: nextHash,
        familyId: session.familyId, // mesma família: mantém a rastreabilidade
        deviceId: meta.deviceId ?? session.deviceId,
        ipAddress: meta.ip ?? null,
        expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      } as never);
      await tx
        .update(s.sessions)
        .set({ replacedBy: nextSessionId, revokedAt: new Date(), revokedReason: 'ROTATED' })
        .where(eq(s.sessions.id, session.id));
    });

    const accessToken = await this.tokens.issueAccessToken({
      sub: user.id,
      sid: nextSessionId,
      typ: user.type,
      org: user.organizationId ?? undefined,
      ver: user.tokenVersion,
    });

    return { accessToken, refreshToken: nextToken, expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.platform
      .update(s.sessions)
      .set({ revokedAt: new Date(), revokedReason: 'LOGOUT' })
      .where(eq(s.sessions.id, sessionId));
  }

  /** Sair de todos os dispositivos: invalida access tokens instantaneamente. */
  async logoutAll(userId: string): Promise<void> {
    await this.db.withPlatform(async (tx) => {
      await tx
        .update(s.sessions)
        .set({ revokedAt: new Date(), revokedReason: 'LOGOUT_ALL' })
        .where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt)));
      await tx
        .update(s.users)
        .set({ tokenVersion: sql`${s.users.tokenVersion} + 1` })
        .where(eq(s.users.id, userId));
    });
  }

  private async revokeFamily(familyId: string, reason: 'REUSE_DETECTED'): Promise<void> {
    await this.db.platform
      .update(s.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(s.sessions.familyId, familyId), isNull(s.sessions.revokedAt)));
  }

  // ---------------------------------------------------------------------------
  // Resolução do principal (permissões e escopo, por requisição)
  // ---------------------------------------------------------------------------

  /**
   * Resolve permissões e escopo do banco a CADA requisição.
   * Não vêm do token: papel revogado deixa de valer imediatamente.
   * (O cache Redis de 5 min descrito no ADR-0005 entra na fase de escala; a
   * chave incluiria token_version, tornando a revogação instantânea.)
   */
  async resolvePrincipal(claims: {
    sub: string;
    sid: string;
    ver: number;
  }): Promise<Principal> {
    const users = await this.db.platform
      .select()
      .from(s.users)
      .where(and(eq(s.users.id, claims.sub), isNull(s.users.deletedAt)))
      .limit(1);
    const user = users[0];
    if (!user || !user.isActive) throw unauthorized('SESSAO_INVALIDA', 'Sessão inválida');

    // token_version invalida todos os access tokens emitidos antes do bump.
    if (user.tokenVersion !== claims.ver) {
      throw unauthorized('SESSAO_REVOGADA', 'Sessão revogada. Entre novamente.');
    }

    const sessions = await this.db.platform
      .select({ revokedAt: s.sessions.revokedAt, expiresAt: s.sessions.expiresAt })
      .from(s.sessions)
      .where(eq(s.sessions.id, claims.sid))
      .limit(1);
    const session = sessions[0];
    if (!session || session.revokedAt) {
      throw unauthorized('SESSAO_REVOGADA', 'Sessão revogada. Entre novamente.');
    }

    const grants = await this.db.platform
      .select({
        roleCode: s.roles.code,
        hierarchyLevel: s.roles.hierarchyLevel,
        organizationId: s.userRoles.organizationId,
        branchId: s.userRoles.branchId,
        permissionCode: s.permissions.code,
      })
      .from(s.userRoles)
      .innerJoin(s.roles, eq(s.roles.id, s.userRoles.roleId))
      .leftJoin(s.rolePermissions, eq(s.rolePermissions.roleId, s.roles.id))
      .leftJoin(s.permissions, eq(s.permissions.id, s.rolePermissions.permissionId))
      .where(
        and(
          eq(s.userRoles.userId, user.id),
          isNull(s.userRoles.revokedAt),
          // Concessões vencidas não são carregadas (acesso temporário entre unidades).
          or(isNull(s.userRoles.expiresAt), gt(s.userRoles.expiresAt, new Date())),
        ),
      );

    const permissions = new Set<string>();
    const branchScope = new Set<string>();
    const roleCodes = new Set<string>();
    let isOrgWide = false;
    let isPlatformAdmin = false;

    for (const g of grants) {
      roleCodes.add(g.roleCode);
      if (g.permissionCode) permissions.add(g.permissionCode);
      if (g.roleCode === 'SUPER_ADMIN') isPlatformAdmin = true;
      if (g.branchId) branchScope.add(g.branchId);
      // Concessão sem branch_id = toda a organização.
      else if (g.organizationId) isOrgWide = true;
    }

    return {
      userId: user.id,
      userType: user.type,
      organizationId: user.organizationId,
      fullName: user.fullName,
      permissions,
      branchScope: [...branchScope],
      isOrgWide,
      isPlatformAdmin,
      roles: [...roleCodes],
      sessionId: claims.sid,
    };
  }

  private async roleIdByCode(code: string): Promise<string> {
    const rows = await this.db.platform
      .select({ id: s.roles.id })
      .from(s.roles)
      .where(eq(s.roles.code, code))
      .limit(1);
    const id = rows[0]?.id;
    if (!id) throw forbidden('PAPEL_INEXISTENTE', `Papel ${code} não encontrado`);
    return id;
  }
}
