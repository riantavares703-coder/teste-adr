/**
 * Schema Drizzle — espelha apps/api/src/db/migrations/0001_baseline.sql.
 *
 * A migração SQL é a AUTORIDADE (ADR-0004: migrações em SQL versionado, porque
 * triggers, políticas de RLS e constraints de exclusão não são expressáveis por
 * geradores de ORM). Este arquivo dá tipagem às consultas.
 *
 * O teste test/schema-parity.test.ts verifica que os dois não divergiram.
 */
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

const inet = customType<{ data: string }>({
  dataType: () => 'inet',
});

const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

// --- enums -------------------------------------------------------------------

export const orgStatus = pgEnum('org_status', ['ACTIVE', 'SUSPENDED', 'CANCELLED']);
export const branchStatus = pgEnum('branch_status', [
  'ACTIVE',
  'PAUSED',
  'CLOSED_TEMPORARILY',
  'ARCHIVED',
]);
export const userType = pgEnum('user_type', ['STAFF', 'CUSTOMER']);
export const availabilityMode = pgEnum('availability_mode', ['INFINITE', 'LIMITED']);
export const movementType = pgEnum('movement_type', [
  'RESERVE',
  'COMMIT',
  'RELEASE',
  'EXPIRE_RELEASE',
  'MANUAL_ADJUST',
  'RESTOCK',
  'SOLD_OUT_MANUAL',
  'REACTIVATE',
  'RECONCILE',
]);
export const reservationStatus = pgEnum('reservation_status', [
  'ACTIVE',
  'COMMITTED',
  'RELEASED',
  'EXPIRED',
]);
export const fulfillmentType = pgEnum('fulfillment_type', ['PICKUP', 'DELIVERY']);

/** Sem AWAITING_PAYMENT — ver docs/ARQUITETURA-DELTA.md §1. */
export const orderStatus = pgEnum('order_status', [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'READY',
  'AWAITING_PICKUP',
  'OUT_FOR_DELIVERY',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
]);

export const paymentMethod = pgEnum('payment_method', [
  'PIX',
  'CREDIT_ON_SITE',
  'DEBIT_ON_SITE',
  'CASH_ON_SITE',
]);
export const paymentStatus = pgEnum('payment_status', [
  'PENDING',
  'AWAITING_CONFIRMATION',
  'CONFIRMED',
  'FAILED',
  'REFUNDED',
  'CANCELLED',
]);
export const actorType = pgEnum('actor_type', ['CUSTOMER', 'STAFF', 'SYSTEM', 'WEBHOOK']);
export const notificationChannel = pgEnum('notification_channel', [
  'WHATSAPP',
  'PUSH',
  'EMAIL',
  'SMS',
]);
export const notificationStatus = pgEnum('notification_status', [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'SKIPPED',
]);
export const auditResult = pgEnum('audit_result', ['SUCCESS', 'FAILURE', 'DENIED']);
export const pixKeyType = pgEnum('pix_key_type', ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM']);
export const sessionRevokeReason = pgEnum('session_revoke_reason', [
  'LOGOUT',
  'LOGOUT_ALL',
  'ROTATED',
  'REUSE_DETECTED',
  'PASSWORD_CHANGED',
  'ADMIN_REVOKED',
  'EXPIRED',
]);
export const deliveryZoneType = pgEnum('delivery_zone_type', ['RADIUS', 'POSTAL_RANGE']);

// --- tenancy -----------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  slug: citext('slug').notNull(),
  legalName: text('legal_name').notNull(),
  tradeName: text('trade_name').notNull(),
  contactEmail: citext('contact_email').notNull(),
  contactPhone: text('contact_phone'),
  status: orgStatus('status').notNull().default('ACTIVE'),
  featureFlags: jsonb('feature_flags').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const branches = pgTable('branches', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  slug: citext('slug').notNull(),
  name: text('name').notNull(),
  phoneE164: text('phone_e164'),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  status: branchStatus('status').notNull().default('ACTIVE'),
  postalCode: text('postal_code'),
  street: text('street'),
  streetNumber: text('street_number'),
  complement: text('complement'),
  district: text('district'),
  city: text('city'),
  stateCode: char('state_code', { length: 2 }),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  acceptsPickup: boolean('accepts_pickup').notNull().default(true),
  acceptsDelivery: boolean('accepts_delivery').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const storeSettings = pgTable('store_settings', {
  branchId: uuid('branch_id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  preparationTimeMinutes: integer('preparation_time_minutes').notNull().default(20),
  minOrderCents: bigint('min_order_cents', { mode: 'number' }).notNull().default(0),
  autoAcceptOrders: boolean('auto_accept_orders').notNull().default(false),
  paymentHoldMinutes: integer('payment_hold_minutes').notNull().default(15),
  enabledPaymentMethods: text('enabled_payment_methods').array().notNull(),
  cancellationWindowMinutes: integer('cancellation_window_minutes').notNull().default(5),
  currency: char('currency', { length: 3 }).notNull().default('BRL'),
});

export const brandFont = pgEnum('brand_font', [
  'INTER',
  'POPPINS',
  'MONTSERRAT',
  'ROBOTO',
  'NUNITO',
  'DM_SANS',
]);

export const gradientStyle = pgEnum('gradient_style', [
  'NONE',
  'VERTICAL',
  'HORIZONTAL',
  'DIAGONAL',
  'DIAGONAL_REVERSE',
]);

export const brandingSettings = pgTable('branding_settings', {
  branchId: uuid('branch_id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  logoStorageKey: text('logo_storage_key'),
  coverStorageKey: text('cover_storage_key'),
  iconStorageKey: text('icon_storage_key'),
  primaryColor: char('primary_color', { length: 7 }),
  secondaryColor: char('secondary_color', { length: 7 }),
  accentColor: char('accent_color', { length: 7 }),
  textColor: char('text_color', { length: 7 }),
  backgroundColor: char('background_color', { length: 7 }),
  cardColor: char('card_color', { length: 7 }),
  gradientFrom: char('gradient_from', { length: 7 }),
  gradientTo: char('gradient_to', { length: 7 }),
  fontToken: brandFont('font_token'),
  gradientStyle: gradientStyle('gradient_style'),
  displayName: text('display_name'),
  tagline: text('tagline'),
  updatedBy: uuid('updated_by'),
});

export const pixSettings = pgTable('pix_settings', {
  branchId: uuid('branch_id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  keyType: pixKeyType('key_type').notNull(),
  keyEncrypted: bytea('key_encrypted').notNull(),
  keyLast4: text('key_last4').notNull(),
  keyFingerprint: bytea('key_fingerprint').notNull(),
  merchantName: text('merchant_name').notNull(),
  merchantCity: text('merchant_city').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const businessHours = pgTable('business_hours', {
  id: uuid('id').primaryKey(),
  branchId: uuid('branch_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  weekday: smallint('weekday').notNull(),
  opensAt: text('opens_at').notNull(),
  closesAt: text('closes_at').notNull(),
});

// --- identidade --------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  type: userType('type').notNull(),
  organizationId: uuid('organization_id'),
  email: citext('email'),
  phoneE164: text('phone_e164'),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash'),
  passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
  tokenVersion: integer('token_version').notNull().default(1),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  failedLoginCount: smallint('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  hierarchyLevel: smallint('hierarchy_level').notNull(),
});

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull(),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id').notNull(),
    permissionId: uuid('permission_id').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permissionId] }) }),
);

export const userRoles = pgTable('user_roles', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
  organizationId: uuid('organization_id'),
  branchId: uuid('branch_id'),
  grantedBy: uuid('granted_by'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const customerOrganizationLinks = pgTable('customer_organization_links', {
  id: uuid('id').primaryKey(),
  customerId: uuid('customer_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  firstOrderAt: timestamp('first_order_at', { withTimezone: true }),
  lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
  ordersCount: integer('orders_count').notNull().default(0),
  whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
  whatsappOptInAt: timestamp('whatsapp_opt_in_at', { withTimezone: true }),
  marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  refreshTokenHash: bytea('refresh_token_hash').notNull(),
  familyId: uuid('family_id').notNull(),
  replacedBy: uuid('replaced_by'),
  deviceId: text('device_id'),
  deviceName: text('device_name'),
  userAgent: text('user_agent'),
  ipAddress: inet('ip_address'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: sessionRevokeReason('revoked_reason'),
});

export const loginAttempts = pgTable('login_attempts', {
  id: uuid('id').primaryKey(),
  identifier: citext('identifier').notNull(),
  userId: uuid('user_id'),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  succeeded: boolean('succeeded').notNull(),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const otpCodes = pgTable('otp_codes', {
  id: uuid('id').primaryKey(),
  identifier: citext('identifier').notNull(),
  codeHash: bytea('code_hash').notNull(),
  purpose: text('purpose').notNull(),
  attempts: smallint('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const deviceTokens = pgTable('device_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  platform: text('platform').notNull(),
  token: text('token').notNull(),
  deviceId: text('device_id'),
  isActive: boolean('is_active').notNull().default(true),
});

// --- catálogo ----------------------------------------------------------------

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    position: smallint('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({ branchIdx: index('categories_branch_idx_drizzle').on(t.branchId, t.position) }),
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    categoryId: uuid('category_id'),
    name: text('name').notNull(),
    description: text('description'),
    sku: text('sku'),
    priceCents: bigint('price_cents', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('BRL'),
    isActive: boolean('is_active').notNull().default(true),
    isFeatured: boolean('is_featured').notNull().default(false),
    notes: text('notes'),
    allowsCustomerNotes: boolean('allows_customer_notes').notNull().default(true),
    preparationTimeMinutes: integer('preparation_time_minutes'),
    position: smallint('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({ menuIdx: index('products_menu_idx_drizzle').on(t.branchId, t.categoryId, t.position) }),
);

export const productImages = pgTable('product_images', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  storageKey: text('storage_key').notNull(),
  thumbStorageKey: text('thumb_storage_key'),
  mediumStorageKey: text('medium_storage_key'),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  width: integer('width'),
  height: integer('height'),
  blurhash: text('blurhash'),
  altText: text('alt_text'),
  position: smallint('position').notNull().default(0),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const modifierGroups = pgTable('modifier_groups', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  name: text('name').notNull(),
  minSelect: smallint('min_select').notNull().default(0),
  maxSelect: smallint('max_select').notNull().default(1),
  isRequired: boolean('is_required').notNull().default(false),
  position: smallint('position').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const modifierOptions = pgTable('modifier_options', {
  id: uuid('id').primaryKey(),
  modifierGroupId: uuid('modifier_group_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  name: text('name').notNull(),
  priceDeltaCents: bigint('price_delta_cents', { mode: 'number' }).notNull().default(0),
  isAvailable: boolean('is_available').notNull().default(true),
  position: smallint('position').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const productModifierGroups = pgTable(
  'product_modifier_groups',
  {
    productId: uuid('product_id').notNull(),
    modifierGroupId: uuid('modifier_group_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    position: smallint('position').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.productId, t.modifierGroupId] }) }),
);

// --- estoque -----------------------------------------------------------------

export const virtualInventory = pgTable(
  'virtual_inventory',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    productId: uuid('product_id').notNull(),
    mode: availabilityMode('mode').notNull().default('INFINITE'),
    onHandQty: integer('on_hand_qty').notNull().default(0),
    reservedQty: integer('reserved_qty').notNull().default(0),
    isManuallySoldOut: boolean('is_manually_sold_out').notNull().default(false),
    soldOutBy: uuid('sold_out_by'),
    soldOutAt: timestamp('sold_out_at', { withTimezone: true }),
    reactivatedBy: uuid('reactivated_by'),
    reactivatedAt: timestamp('reactivated_at', { withTimezone: true }),
    lowStockThreshold: integer('low_stock_threshold'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ productUk: uniqueIndex('virtual_inventory_product_uk_drizzle').on(t.productId) }),
);

export const inventoryMovements = pgTable('inventory_movements', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  virtualInventoryId: uuid('virtual_inventory_id').notNull(),
  productId: uuid('product_id').notNull(),
  type: movementType('type').notNull(),
  quantityDelta: integer('quantity_delta').notNull(),
  onHandAfter: integer('on_hand_after').notNull(),
  reservedAfter: integer('reserved_after').notNull(),
  orderId: uuid('order_id'),
  actorUserId: uuid('actor_user_id'),
  actorType: actorType('actor_type').notNull().default('SYSTEM'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inventoryReservations = pgTable('inventory_reservations', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  orderId: uuid('order_id').notNull(),
  virtualInventoryId: uuid('virtual_inventory_id').notNull(),
  quantity: integer('quantity').notNull(),
  status: reservationStatus('status').notNull().default('ACTIVE'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

// --- entrega -----------------------------------------------------------------

export const deliveryAddresses = pgTable('delivery_addresses', {
  id: uuid('id').primaryKey(),
  customerId: uuid('customer_id').notNull(),
  label: text('label'),
  postalCode: text('postal_code').notNull(),
  street: text('street').notNull(),
  streetNumber: text('street_number').notNull(),
  complement: text('complement'),
  district: text('district').notNull(),
  city: text('city').notNull(),
  stateCode: char('state_code', { length: 2 }).notNull(),
  reference: text('reference'),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  isDefault: boolean('is_default').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const deliveryZones = pgTable('delivery_zones', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  name: text('name').notNull(),
  type: deliveryZoneType('type').notNull(),
  radiusMeters: integer('radius_meters'),
  postalCodeFrom: text('postal_code_from'),
  postalCodeTo: text('postal_code_to'),
  feeCents: bigint('fee_cents', { mode: 'number' }).notNull(),
  minOrderCents: bigint('min_order_cents', { mode: 'number' }).notNull().default(0),
  etaMinutes: integer('eta_minutes').notNull().default(40),
  isActive: boolean('is_active').notNull().default(true),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// --- pedidos -----------------------------------------------------------------

export const orderNumberCounters = pgTable(
  'order_number_counters',
  {
    branchId: uuid('branch_id').notNull(),
    businessDate: date('business_date').notNull(),
    lastNumber: integer('last_number').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.branchId, t.businessDate] }) }),
);

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  orderNumber: text('order_number').notNull(),
  status: orderStatus('status').notNull().default('PENDING'),
  fulfillment: fulfillmentType('fulfillment').notNull(),
  paymentMethod: paymentMethod('payment_method').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('BRL'),
  subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull(),
  deliveryFeeCents: bigint('delivery_fee_cents', { mode: 'number' }).notNull().default(0),
  discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  deliveryAddressId: uuid('delivery_address_id'),
  deliveryAddressSnapshot: jsonb('delivery_address_snapshot'),
  deliveryZoneId: uuid('delivery_zone_id'),
  customerNotes: text('customer_notes'),
  internalNotes: text('internal_notes'),
  changeForCents: bigint('change_for_cents', { mode: 'number' }),
  estimatedReadyAt: timestamp('estimated_ready_at', { withTimezone: true }),
  reservationExpiresAt: timestamp('reservation_expires_at', { withTimezone: true }),
  placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancellationReason: text('cancellation_reason'),
  clientIp: inet('client_ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  productId: uuid('product_id').notNull(),
  productNameSnapshot: text('product_name_snapshot').notNull(),
  productSkuSnapshot: text('product_sku_snapshot'),
  productImageKeySnapshot: text('product_image_key_snapshot'),
  unitPriceCentsSnapshot: bigint('unit_price_cents_snapshot', { mode: 'number' }).notNull(),
  quantity: integer('quantity').notNull(),
  optionsTotalCents: bigint('options_total_cents', { mode: 'number' }).notNull().default(0),
  lineTotalCents: bigint('line_total_cents', { mode: 'number' }).notNull(),
  notes: text('notes'),
});

export const orderItemOptions = pgTable('order_item_options', {
  id: uuid('id').primaryKey(),
  orderItemId: uuid('order_item_id').notNull(),
  modifierOptionId: uuid('modifier_option_id'),
  optionNameSnapshot: text('option_name_snapshot').notNull(),
  groupNameSnapshot: text('group_name_snapshot').notNull(),
  priceDeltaCentsSnapshot: bigint('price_delta_cents_snapshot', { mode: 'number' }).notNull(),
  quantity: smallint('quantity').notNull().default(1),
});

export const orderStatusHistory = pgTable('order_status_history', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  fromStatus: orderStatus('from_status'),
  toStatus: orderStatus('to_status').notNull(),
  actorUserId: uuid('actor_user_id'),
  actorType: actorType('actor_type').notNull(),
  reason: text('reason'),
  metadata: jsonb('metadata').notNull().default({}),
  ipAddress: inet('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- pagamentos --------------------------------------------------------------

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  orderId: uuid('order_id').notNull(),
  method: paymentMethod('method').notNull(),
  status: paymentStatus('status').notNull().default('PENDING'),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('BRL'),
  provider: text('provider').notNull(),
  providerPaymentId: text('provider_payment_id'),
  pixBrcode: text('pix_brcode'),
  pixTxid: text('pix_txid'),
  pixKeyLast4: text('pix_key_last4'),
  confirmedBy: uuid('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  confirmedIp: inet('confirmed_ip'),
  confirmationNote: text('confirmation_note'),
  failureReason: text('failure_reason'),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const paymentEvents = pgTable('payment_events', {
  id: uuid('id').primaryKey(),
  paymentId: uuid('payment_id').notNull(),
  eventType: text('event_type').notNull(),
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id'),
  payload: jsonb('payload').notNull(),
  signatureValid: boolean('signature_valid'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- plataforma --------------------------------------------------------------

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id'),
  branchId: uuid('branch_id'),
  actorUserId: uuid('actor_user_id'),
  actorType: actorType('actor_type').notNull().default('STAFF'),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: uuid('resource_id'),
  result: auditResult('result').notNull().default('SUCCESS'),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  metadata: jsonb('metadata').notNull().default({}),
  prevHash: bytea('prev_hash'),
  recordHash: bytea('record_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id'),
  branchId: uuid('branch_id'),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: smallint('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
});

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id'),
  orderId: uuid('order_id'),
  recipientUserId: uuid('recipient_user_id'),
  recipientAddress: text('recipient_address'),
  channel: notificationChannel('channel').notNull(),
  templateName: text('template_name'),
  templateVariables: jsonb('template_variables').notNull().default({}),
  status: notificationStatus('status').notNull().default('QUEUED'),
  provider: text('provider'),
  providerMessageId: text('provider_message_id'),
  attempts: smallint('attempts').notNull().default(0),
  failureReason: text('failure_reason'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const whatsappIntegrations = pgTable('whatsapp_integrations', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  branchId: uuid('branch_id'),
  provider: text('provider').notNull().default('META_CLOUD_API'),
  wabaId: text('waba_id'),
  phoneNumberId: text('phone_number_id').notNull(),
  displayPhoneNumber: text('display_phone_number'),
  accessTokenSecretRef: text('access_token_secret_ref').notNull(),
  webhookVerifyTokenRef: text('webhook_verify_token_ref'),
  appSecretRef: text('app_secret_ref'),
  templateMap: jsonb('template_map').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  userId: uuid('user_id'),
  endpoint: text('endpoint').notNull(),
  requestHash: bytea('request_hash').notNull(),
  responseStatus: smallint('response_status'),
  responseBody: jsonb('response_body'),
  resourceId: uuid('resource_id'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id'),
  branchId: uuid('branch_id'),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  checksumSha256: bytea('checksum_sha256').notNull(),
  uploadedBy: uuid('uploaded_by'),
  scanStatus: text('scan_status').notNull().default('PENDING'),
  isConfirmed: boolean('is_confirmed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
