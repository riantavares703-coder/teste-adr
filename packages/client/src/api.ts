import type {
  AvailabilityView,
  FontToken,
  GradientStyle,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ResolvedTheme,
} from '@plataforma/domain';

/**
 * Cliente HTTP compartilhado pelos três aplicativos.
 *
 * Concentra três coisas que não podem ser reimplementadas por app:
 *  - renovação automática do access token (com fila, para não disparar N
 *    refreshes simultâneos quando várias telas expiram ao mesmo tempo);
 *  - tratamento uniforme de erro RFC 9457;
 *  - Idempotency-Key na criação de pedido.
 *
 * O access token vive apenas em MEMÓRIA. O refresh token fica no
 * Keychain/Keystore, e é o app quem injeta o armazenamento seguro — este
 * pacote nunca decide onde guardar segredo.
 */

export interface TokenStorage {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string | null): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

// --- tipos de resposta -------------------------------------------------------

export interface MenuProduct {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  categoryId: string | null;
  isFeatured: boolean;
  allowsCustomerNotes: boolean;
  imageUrl: string | null;
  thumbUrl: string | null;
  availability: AvailabilityView;
}

export interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  products: MenuProduct[];
}

/**
 * Tema JÁ RESOLVIDO pelo servidor.
 *
 * O app não recebe a configuração crua e recalcula: recebe as cores derivadas
 * prontas (`onPrimary`, `border`, `overlay`). Um app antigo, que não conheça
 * uma regra nova de contraste, ainda desenha a marca corretamente.
 */
export interface StorefrontTheme extends ResolvedTheme {
  displayName: string | null;
  tagline: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
  coverUrl: string | null;
}

export interface BranchSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  city: string | null;
  district: string | null;
  street: string | null;
  streetNumber: string | null;
  acceptsPickup: boolean;
  acceptsDelivery: boolean;
  logoUrl: string | null;
  primaryColor: string | null;
}

export interface BrandingSettings {
  branchId: string;
  displayName: string | null;
  tagline: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  textColor: string;
  backgroundColor: string;
  cardColor: string;
  fontToken: FontToken;
  gradientStyle: GradientStyle;
  gradientFrom: string;
  gradientTo: string;
  logoUrl: string | null;
  iconUrl: string | null;
  coverUrl: string | null;
}

export interface ShareLink {
  organizationSlug: string;
  branchSlug: string;
  /** URL que vai no QR code, já com o endereço de rede da máquina. */
  menuUrl: string;
  lanAddress: string | null;
  /** Falso quando o endereço só funciona na própria máquina do operador. */
  reachableFromPhones: boolean;
}

export interface AnalyticsSummary {
  periodDays: number;
  since: string;
  scope: 'ORGANIZATION' | 'BRANCHES';
  branchCount: number;
  totals: {
    orderCount: number;
    revenueCents: number;
    averageTicketCents: number;
    cancelledCount: number;
  };
  byBranch: Array<{
    branchId: string;
    branchName: string;
    orderCount: number;
    revenueCents: number;
    averageTicketCents: number;
  }>;
  topProducts: Array<{
    productId: string;
    productName: string;
    quantity: number;
    revenueCents: number;
  }>;
}

export interface Menu {
  branch: {
    id: string;
    name: string;
    slug: string;
    status: string;
    acceptsPickup: boolean;
    acceptsDelivery: boolean;
    city: string | null;
    district: string | null;
  };
  theme: StorefrontTheme;
  settings: {
    minOrderCents: number;
    preparationTimeMinutes: number;
    enabledPaymentMethods: PaymentMethod[];
  } | null;
  categories: MenuCategory[];
  featured: MenuProduct[];
  uncategorized: MenuProduct[];
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
  options: Array<{ id: string; name: string; priceDeltaCents: number }>;
}

export interface ProductDetail extends Omit<MenuProduct, 'categoryId' | 'thumbUrl'> {
  images: Array<{ url: string; thumbUrl: string | null; altText: string | null }>;
  modifierGroups: ModifierGroup[];
}

export interface OrderItem {
  id: string;
  productId: string;
  productNameSnapshot: string;
  unitPriceCentsSnapshot: number;
  quantity: number;
  optionsTotalCents: number;
  lineTotalCents: number;
  notes: string | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  branchId: string;
  status: OrderStatus;
  fulfillment: 'PICKUP' | 'DELIVERY';
  paymentMethod: PaymentMethod;
  subtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
  customerNotes: string | null;
  placedAt: string;
  reservationExpiresAt: string | null;
}

export interface PaymentView {
  id: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amountCents: number;
  pixBrcode: string | null;
  pixKeyMasked: string | null;
  provider: string;
  /** Nenhum provedor confirma sozinho hoje — o app precisa dizer isso ao cliente. */
  automaticConfirmation: boolean;
  confirmedAt: string | null;
}

export interface OrderDetail {
  order: Order;
  items: OrderItem[];
  payment: PaymentView | null;
  history: Array<{ toStatus: OrderStatus; createdAt: string; reason: string | null }>;
}

export interface InventoryRow {
  productId: string;
  productName: string;
  mode: 'INFINITE' | 'LIMITED';
  onHandQty: number;
  reservedQty: number;
  isManuallySoldOut: boolean;
  availability: AvailabilityView;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface Profile {
  userId: string;
  userType: 'STAFF' | 'CUSTOMER';
  fullName: string;
  organizationId: string | null;
  roles: string[];
  permissions: string[];
  branchScope: string[];
  isOrgWide: boolean;
  isPlatformAdmin: boolean;
}

// --- cliente -----------------------------------------------------------------

export interface CreateOrderPayload {
  branchId: string;
  fulfillment: 'PICKUP' | 'DELIVERY';
  paymentMethod: PaymentMethod;
  items: Array<{
    productId: string;
    quantity: number;
    optionIds?: string[];
    notes?: string;
  }>;
  deliveryAddressId?: string;
  customerNotes?: string;
  changeForCents?: number;
  /** Só para detectar divergência — o servidor cobra o que recalcular. */
  expectedTotalCents?: number;
}

export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly storage: TokenStorage,
    private readonly onSessionLost?: () => void,
  ) {}

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  async saveSession(session: Session): Promise<void> {
    this.accessToken = session.accessToken;
    await this.storage.setRefreshToken(session.refreshToken);
  }

  async clearSession(): Promise<void> {
    this.accessToken = null;
    await this.storage.setRefreshToken(null);
  }

  // --- autenticação ----------------------------------------------------------

  async loginStaff(input: {
    organizationSlug: string;
    email: string;
    password: string;
    deviceId?: string;
  }): Promise<Session> {
    const session = await this.request<Session>('POST', '/v1/auth/login', { body: input });
    await this.saveSession(session);
    return session;
  }

  requestOtp(phone: string): Promise<{ expiresIn: number }> {
    return this.request('POST', '/v1/auth/otp/request', { body: { phone } });
  }

  async verifyOtp(input: { phone: string; code: string; fullName?: string }): Promise<Session> {
    const session = await this.request<Session>('POST', '/v1/auth/otp/verify', { body: input });
    await this.saveSession(session);
    return session;
  }

  me(): Promise<Profile> {
    return this.request('GET', '/v1/auth/me');
  }

  async logout(): Promise<void> {
    await this.request('POST', '/v1/auth/logout', { body: {} }).catch(() => undefined);
    await this.clearSession();
  }

  /** Restaura a sessão a partir do refresh token guardado com segurança. */
  async restoreSession(): Promise<boolean> {
    const refreshToken = await this.storage.getRefreshToken();
    if (!refreshToken) return false;
    try {
      const session = await this.request<Session>('POST', '/v1/auth/refresh', {
        body: { refreshToken },
        skipAuth: true,
      });
      await this.saveSession(session);
      return true;
    } catch {
      await this.clearSession();
      return false;
    }
  }

  // --- vitrine ---------------------------------------------------------------

  /** Unidades da franquia, para a etapa "escolher unidade". */
  listBranches(organizationSlug: string): Promise<BranchSummary[]> {
    return this.request('GET', `/v1/public/${organizationSlug}/branches`);
  }

  getMenu(organizationSlug: string, branchSlug: string): Promise<Menu> {
    return this.request('GET', `/v1/public/${organizationSlug}/${branchSlug}/menu`);
  }

  getProduct(productId: string): Promise<ProductDetail> {
    return this.request('GET', `/v1/public/products/${productId}`);
  }

  mediaUrl(path: string | null): string | null {
    return path ? `${this.baseUrl}${path}` : null;
  }

  // --- pedidos (cliente) -----------------------------------------------------

  createOrder(payload: CreateOrderPayload, idempotencyKey: string): Promise<OrderDetail> {
    return this.request('POST', '/v1/orders', {
      body: payload,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  listMyOrders(): Promise<OrderDetail[]> {
    return this.request('GET', '/v1/orders');
  }

  getOrder(orderId: string): Promise<OrderDetail> {
    return this.request('GET', `/v1/orders/${orderId}`);
  }

  cancelOrder(orderId: string): Promise<{ status: OrderStatus }> {
    return this.request('POST', `/v1/orders/${orderId}/cancel`, { body: {} });
  }

  getPayment(orderId: string): Promise<PaymentView> {
    return this.request('GET', `/v1/orders/${orderId}/payment`);
  }

  // --- operação --------------------------------------------------------------

  /**
   * Endereço do cardápio desta unidade, para o QR code do balcão.
   *
   * Resolvido no SERVIDOR de propósito: montar a URL a partir de
   * `window.location` produziria "localhost", que é justamente o endereço que
   * não funciona no celular do cliente.
   */
  getShareLink(branchId: string): Promise<ShareLink> {
    return this.request('GET', `/v1/branches/${branchId}/share-link`);
  }

  listBranchOrders(branchId: string, statuses?: OrderStatus[]): Promise<OrderDetail[]> {
    const query = statuses?.length ? `?status=${statuses.join(',')}` : '';
    return this.request('GET', `/v1/branches/${branchId}/orders${query}`);
  }

  transitionOrder(
    branchId: string,
    orderId: string,
    to: OrderStatus,
    reason?: string,
  ): Promise<{ status: OrderStatus }> {
    return this.request('POST', `/v1/branches/${branchId}/orders/${orderId}/transition`, {
      body: reason ? { to, reason } : { to },
    });
  }

  confirmPayment(branchId: string, paymentId: string, note?: string) {
    return this.request<{ paymentStatus: PaymentStatus; orderStatus: OrderStatus }>(
      'POST',
      `/v1/branches/${branchId}/payments/${paymentId}/confirm`,
      { body: note ? { note } : {} },
    );
  }

  // --- estoque ---------------------------------------------------------------

  listInventory(branchId: string): Promise<InventoryRow[]> {
    return this.request('GET', `/v1/branches/${branchId}/inventory`);
  }

  markSoldOut(branchId: string, productId: string, reason?: string): Promise<InventoryRow> {
    return this.request('POST', `/v1/branches/${branchId}/inventory/${productId}/sold-out`, {
      body: reason ? { reason } : {},
    });
  }

  reactivate(branchId: string, productId: string): Promise<InventoryRow> {
    return this.request('POST', `/v1/branches/${branchId}/inventory/${productId}/reactivate`, {
      body: {},
    });
  }

  adjustStock(
    branchId: string,
    productId: string,
    delta: number,
    reason?: string,
  ): Promise<InventoryRow> {
    return this.request('POST', `/v1/branches/${branchId}/inventory/${productId}/adjust`, {
      body: reason ? { delta, reason } : { delta },
    });
  }

  // --- catálogo (administração) ----------------------------------------------

  listProducts(branchId: string): Promise<Array<MenuProduct & { isActive: boolean }>> {
    return this.request('GET', `/v1/branches/${branchId}/products`);
  }

  createProduct(branchId: string, body: Record<string, unknown>) {
    return this.request('POST', `/v1/branches/${branchId}/products`, { body });
  }

  updateProduct(branchId: string, productId: string, body: Record<string, unknown>) {
    return this.request('PATCH', `/v1/branches/${branchId}/products/${productId}`, { body });
  }

  listCategories(branchId: string) {
    return this.request<Array<{ id: string; name: string }>>(
      'GET',
      `/v1/branches/${branchId}/categories`,
    );
  }

  createCategory(branchId: string, body: { name: string; description?: string }) {
    return this.request('POST', `/v1/branches/${branchId}/categories`, { body });
  }

  // --- aparência e indicadores (administração) -------------------------------

  getBranding(branchId: string): Promise<BrandingSettings> {
    return this.request('GET', `/v1/branches/${branchId}/branding`);
  }

  /**
   * Grava a identidade visual.
   *
   * O corpo é tipado com os campos exatos: um `Record<string, unknown>` aqui
   * abriria espaço para o app mandar chave inventada, que o servidor recusa
   * por `.strict()` — melhor o erro aparecer na compilação.
   */
  updateBranding(
    branchId: string,
    body: Partial<Omit<BrandingSettings, 'branchId' | 'logoUrl' | 'iconUrl' | 'coverUrl'>>,
  ): Promise<BrandingSettings> {
    return this.request('PUT', `/v1/branches/${branchId}/branding`, { body });
  }

  /** Indicadores consolidados. Sem `branchId`, o servidor decide o escopo. */
  getAnalytics(options: { days?: number; branchId?: string } = {}): Promise<AnalyticsSummary> {
    const query = new URLSearchParams({ days: String(options.days ?? 30) });
    if (options.branchId) query.set('branchId', options.branchId);
    return this.request('GET', `/v1/analytics/summary?${query.toString()}`);
  }

  setPixSettings(
    branchId: string,
    body: { keyType: string; key: string; merchantName: string; merchantCity: string },
  ) {
    return this.request<{ keyMasked: string }>('PUT', `/v1/branches/${branchId}/pix-settings`, {
      body,
    });
  }

  async uploadProductImage(
    branchId: string,
    productId: string,
    file: { uri: string; mimeType: string; blob: Blob | ArrayBuffer },
    options: { primary?: boolean; alt?: string } = {},
  ): Promise<{ imageId: string; storageKey: string }> {
    const query = new URLSearchParams();
    if (options.primary) query.set('primary', 'true');
    if (options.alt) query.set('alt', options.alt);

    return this.request('POST', `/v1/branches/${branchId}/products/${productId}/images?${query}`, {
      rawBody: file.blob,
      headers: { 'Content-Type': file.mimeType },
    });
  }

  // --- núcleo ----------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      rawBody?: Blob | ArrayBuffer;
      headers?: Record<string, string>;
      skipAuth?: boolean;
      retried?: boolean;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };

    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!options.skipAuth && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body:
        options.rawBody !== undefined
          ? (options.rawBody as BodyInit)
          : options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
    });

    // 401: tenta renovar UMA vez. As renovações concorrentes compartilham a
    // mesma promessa, senão N telas abertas disparariam N refreshes — e a
    // detecção de reuso do servidor derrubaria a sessão do usuário legítimo.
    if (response.status === 401 && !options.skipAuth && !options.retried) {
      await this.ensureRefreshed();
      if (this.accessToken) {
        return this.request<T>(method, path, { ...options, retried: true });
      }
    }

    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new ApiError(
        response.status,
        (problem as { code?: string }).code ?? 'ERRO',
        (problem as { title?: string }).title ?? `Falha na requisição (${response.status})`,
        (problem as { details?: unknown }).details,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async ensureRefreshed(): Promise<void> {
    this.refreshing ??= (async () => {
      const ok = await this.restoreSession();
      if (!ok) this.onSessionLost?.();
    })().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }
}
