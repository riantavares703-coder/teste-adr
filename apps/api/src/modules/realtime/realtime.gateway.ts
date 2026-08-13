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

  /**
   * Guarda a PROMESSA da identidade, não a identidade pronta.
   *
   * Resolver o principal exige verificar o token e consultar o banco, e nesse
   * intervalo o cliente já pode ter enviado `join:branch` — o Socket.IO não
   * segura as mensagens esperando o tratador de conexão terminar. Guardando a
   * promessa (de forma síncrona, antes de qualquer await), quem chega cedo
   * espera pela mesma resolução em vez de encontrar o mapa vazio e levar um
   * "não autorizado" que nada tem a ver com autorização.
   */
  private readonly principals = new Map<string, Promise<Principal | null>>();

  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Database) private readonly db: Database,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Registrado ANTES de qualquer await: é isso que fecha a corrida.
    const resolution = this.resolvePrincipal(client);
    this.principals.set(client.id, resolution);

    const principal = await resolution;
    if (!principal) {
      this.principals.delete(client.id);
      client.disconnect(true);
      return;
    }
    // Sala pessoal: notificações direcionadas ao usuário.
    await client.join(`user:${principal.userId}`);
  }

  private async resolvePrincipal(client: Socket): Promise<Principal | null> {
    try {
      const token = (client.handshake.auth as { token?: string } | undefined)?.token;
      if (!token) return null;
      const claims = await this.tokens.verifyAccessToken(token);
      return await this.auth.resolvePrincipal(claims);
    } catch {
      return null;
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
    const principal = await this.principals.get(client.id);
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
    const principal = await this.principals.get(client.id);
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
