import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { sql } from 'drizzle-orm';
import { canReachBranch, toTenantContext, type Principal } from '../../common/principal.js';
import { Database } from '../../db/client.js';
import { AuthService } from '../auth/auth.service.js';
import { TokenService } from '../auth/token.service.js';

/**
 * Tempo real (item 11 do Prompt 02): o operador não precisa atualizar a tela.
 *
 * Duas decisões de segurança que fazem diferença:
 *
 * 1. O token vem no HANDSHAKE (auth payload), nunca na query string — query
 *    string vaza em log de proxy e no histórico do navegador.
 *
 * 2. Entrar numa sala é REAUTORIZADO no servidor. Sem isso, o WebSocket seria
 *    um IDOR com outro nome: qualquer um entraria em `order:{uuid}` alheio.
 */
@Injectable()
@WebSocketGateway({
  cors: { origin: false },
  transports: ['websocket'],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server?: Server;
  private readonly logger = new Logger('Realtime');
  private readonly principals = new Map<string, Principal>();

  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Database) private readonly db: Database,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = (client.handshake.auth as { token?: string } | undefined)?.token;
      if (!token) {
        client.disconnect(true);
        return;
      }
      const claims = await this.tokens.verifyAccessToken(token);
      const principal = await this.auth.resolvePrincipal(claims);
      this.principals.set(client.id, principal);
      // Sala pessoal: notificações direcionadas ao usuário.
      await client.join(`user:${principal.userId}`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.principals.delete(client.id);
  }

  /** Fila da unidade — apenas staff com escopo naquela unidade. */
  @SubscribeMessage('join:branch')
  async joinBranch(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { branchId?: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const principal = this.principals.get(client.id);
    if (!principal || !body?.branchId) return { ok: false, reason: 'NAO_AUTORIZADO' };
    if (principal.userType !== 'STAFF') return { ok: false, reason: 'NAO_AUTORIZADO' };
    if (!principal.permissions.has('order:read')) return { ok: false, reason: 'NAO_AUTORIZADO' };
    if (!canReachBranch(principal, body.branchId)) return { ok: false, reason: 'NAO_AUTORIZADO' };

    await client.join(`branch:${body.branchId}`);
    return { ok: true };
  }

  /** Acompanhamento de um pedido — apenas o dono ou staff com escopo. */
  @SubscribeMessage('join:order')
  async joinOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { orderId?: string; branchId?: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const principal = this.principals.get(client.id);
    if (!principal || !body?.orderId) return { ok: false, reason: 'NAO_AUTORIZADO' };

    if (principal.userType === 'STAFF') {
      if (!body.branchId || !canReachBranch(principal, body.branchId)) {
        return { ok: false, reason: 'NAO_AUTORIZADO' };
      }
    } else {
      // Cliente: a posse do pedido é conferida no banco, sob RLS.
      const visible = await this.db.withTenant(toTenantContext(principal), (tx) =>
        tx.execute(sql`SELECT 1 FROM orders WHERE id = ${body.orderId}`),
      );
      if (visible.rows.length === 0) return { ok: false, reason: 'NAO_AUTORIZADO' };
    }

    await client.join(`order:${body.orderId}`);
    return { ok: true };
  }

  emitToBranch(branchId: string, event: string, payload: unknown): void {
    this.server?.to(`branch:${branchId}`).emit(event, payload);
  }

  emitToOrder(orderId: string, event: string, payload: unknown): void {
    this.server?.to(`order:${orderId}`).emit(event, payload);
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}
