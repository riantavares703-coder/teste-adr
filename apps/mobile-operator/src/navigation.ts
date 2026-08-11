import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/**
 * Rotas do app de operação.
 *
 * Duas experiências no mesmo binário, separadas por PERMISSÃO:
 *
 *   OPERADOR       Dashboard · Orders · Inventory
 *   ADMINISTRADOR  tudo acima + Settings (14 áreas) · Appearance · Franchise
 *
 * Esconder tela é conveniência. A recusa de verdade é do servidor: mesmo que
 * alguém force a navegação, cada requisição volta 403/404.
 */
export type RootStackParamList = {
  Dashboard: undefined;
  Orders: { filter?: 'NEW' | 'PREPARING' | 'READY' | 'DELIVERY' | 'LATE' | 'UNPAID' } | undefined;
  Inventory: undefined;
  Settings: undefined;
  Appearance: undefined;
  Franchise: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;

/** Área de configuração (item 9). `permission` é o que o servidor exige. */
export interface SettingsSection {
  key: string;
  label: string;
  icon: string;
  description: string;
  permission: string;
  route?: keyof RootStackParamList;
}

/**
 * As 14 áreas do item 9.
 *
 * A lista é declarativa de propósito: cada área carrega a permissão que a
 * governa, e a tela filtra por `profile.permissions`. Um item novo não pode
 * ser acrescentado sem declarar quem pode vê-lo.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    key: 'establishment',
    label: 'Estabelecimento',
    icon: '🏪',
    description: 'Nome, endereço, horários e formas de atendimento',
    permission: 'settings:read',
  },
  {
    key: 'menu',
    label: 'Cardápio',
    icon: '📋',
    description: 'Produtos, categorias, fotos e adicionais',
    permission: 'product:read',
  },
  {
    key: 'inventory',
    label: 'Estoque',
    icon: '📦',
    description: 'Disponibilidade e quantidades por produto',
    permission: 'inventory:read',
    route: 'Inventory',
  },
  {
    key: 'orders',
    label: 'Pedidos',
    icon: '🧾',
    description: 'Fila, prazos e regras de aceite',
    permission: 'order:read',
    route: 'Orders',
  },
  {
    key: 'payments',
    label: 'Pagamentos',
    icon: '💳',
    description: 'Formas aceitas e conferência de recebimento',
    permission: 'payment:read',
  },
  {
    key: 'pix',
    label: 'Pix',
    icon: '⚡',
    description: 'Chave, nome e cidade do recebedor',
    permission: 'pix_settings:read',
  },
  {
    key: 'delivery',
    label: 'Entregas',
    icon: '🛵',
    description: 'Zonas, taxas e entregadores',
    permission: 'delivery:read',
  },
  {
    key: 'whatsapp',
    label: 'WhatsApp',
    icon: '💬',
    description: 'Integração oficial e modelos de mensagem',
    permission: 'whatsapp:configure',
  },
  {
    key: 'users',
    label: 'Usuários',
    icon: '👥',
    description: 'Equipe da unidade e acessos',
    permission: 'user:read',
  },
  {
    key: 'permissions',
    label: 'Permissões',
    icon: '🔑',
    description: 'Papéis e o que cada um pode fazer',
    permission: 'role:assign',
  },
  {
    key: 'appearance',
    label: 'Aparência',
    icon: '🎨',
    description: 'Cores, tipografia, logo e gradiente',
    permission: 'branding:update',
    route: 'Appearance',
  },
  {
    key: 'notifications',
    label: 'Notificações',
    icon: '🔔',
    description: 'Push e avisos ao cliente',
    permission: 'settings:read',
  },
  {
    key: 'security',
    label: 'Segurança',
    icon: '🛡️',
    description: 'Sessões, tentativas de acesso e bloqueios',
    permission: 'settings:update',
  },
  {
    key: 'audit',
    label: 'Auditoria',
    icon: '📜',
    description: 'Trilha imutável de tudo que foi alterado',
    permission: 'audit:read',
  },
];
