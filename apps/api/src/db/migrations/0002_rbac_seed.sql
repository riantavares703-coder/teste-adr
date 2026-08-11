-- =============================================================================
--  PAPÉIS E PERMISSÕES — matriz de docs/06-modelo-de-permissoes.md
-- =============================================================================

INSERT INTO roles (code, name, hierarchy_level, description) VALUES
    ('SUPER_ADMIN',     'Administrador da plataforma', 0, 'Operação da plataforma; acesso auditado'),
    ('FRANCHISE_ADMIN', 'Administrador da franquia',   1, 'Administra a organização e todas as unidades'),
    ('UNIT_MANAGER',    'Gerente de unidade',          2, 'Catálogo, preços, operadores e configurações'),
    ('OPERATOR',        'Operador',                    3, 'Opera pedidos e disponibilidade'),
    ('DELIVERY',        'Entregador',                  4, 'Apenas as entregas atribuídas a ele'),
    ('CUSTOMER',        'Cliente',                     5, 'Compra e acompanha os próprios pedidos')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, resource, action, description) VALUES
    ('organization:read','organization','read','Ver dados da organização'),
    ('organization:update','organization','update','Alterar dados da organização'),
    ('branch:create','branch','create','Criar unidade'),
    ('branch:read','branch','read','Ver unidade'),
    ('branch:update','branch','update','Alterar unidade'),
    ('branch:archive','branch','archive','Arquivar unidade'),
    ('user:create','user','create','Criar usuário'),
    ('user:read','user','read','Ver usuários'),
    ('user:update','user','update','Alterar usuário'),
    ('user:deactivate','user','deactivate','Desativar usuário'),
    ('role:assign','role','assign','Conceder papéis'),
    ('role:revoke','role','revoke','Revogar papéis'),
    ('product:create','product','create','Criar produto'),
    ('product:read','product','read','Ver produtos'),
    ('product:update','product','update','Alterar produto'),
    ('product:delete','product','delete','Excluir produto'),
    ('price:update','price','update','Alterar preço'),
    ('category:manage','category','manage','Gerenciar categorias'),
    ('inventory:read','inventory','read','Ver estoque virtual'),
    ('inventory:adjust','inventory','adjust','Ajustar quantidade'),
    ('inventory:mark_sold_out','inventory','mark_sold_out','Esgotar / reativar'),
    ('order:read','order','read','Ver pedidos da unidade'),
    ('order:read_own','order','read_own','Ver os próprios pedidos'),
    ('order:create','order','create','Criar pedido'),
    ('order:transition','order','transition','Avançar status'),
    ('order:cancel','order','cancel','Cancelar pedido'),
    ('order:refund','order','refund','Estornar pedido'),
    ('payment:read','payment','read','Ver pagamentos'),
    ('payment:confirm','payment','confirm','Confirmar pagamento'),
    ('pix_settings:read','pix_settings','read','Ver configuração de Pix'),
    ('pix_settings:update','pix_settings','update','Alterar chave Pix'),
    ('delivery:read','delivery','read','Ver entregas'),
    ('delivery:assign','delivery','assign','Atribuir entregador'),
    ('delivery:update_own','delivery','update_own','Atualizar as próprias entregas'),
    ('settings:read','settings','read','Ver configurações'),
    ('settings:update','settings','update','Alterar configurações'),
    ('branding:update','branding','update','Alterar identidade visual'),
    ('media:upload','media','upload','Enviar imagens'),
    ('audit:read','audit','read','Ler trilha de auditoria'),
    ('report:read','report','read','Ver relatórios'),
    ('whatsapp:configure','whatsapp','configure','Configurar WhatsApp')
ON CONFLICT (code) DO NOTHING;

-- --- OPERATOR: opera a unidade, não toca em preço, config, usuários nem Pix ---
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'OPERATOR' AND p.code IN (
    'branch:read','product:read','category:manage',
    'inventory:read','inventory:adjust','inventory:mark_sold_out',
    'order:read','order:transition','order:cancel',
    'payment:read','payment:confirm',
    'delivery:read','delivery:assign','settings:read'
) ON CONFLICT DO NOTHING;

-- --- UNIT_MANAGER: tudo do operador + catálogo, preço, usuários, config, Pix ---
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'UNIT_MANAGER' AND p.code IN (
    'branch:read','branch:update',
    'user:create','user:read','user:update','user:deactivate','role:assign','role:revoke',
    'product:create','product:read','product:update','product:delete','price:update',
    'category:manage','media:upload',
    'inventory:read','inventory:adjust','inventory:mark_sold_out',
    'order:read','order:transition','order:cancel','order:refund',
    'payment:read','payment:confirm',
    'pix_settings:read','pix_settings:update',
    'delivery:read','delivery:assign',
    'settings:read','settings:update','branding:update',
    'audit:read','report:read'
) ON CONFLICT DO NOTHING;

-- --- FRANCHISE_ADMIN: tudo do gerente + organização, unidades e WhatsApp ---
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'FRANCHISE_ADMIN' AND p.code NOT IN ('order:create','order:read_own','delivery:update_own')
ON CONFLICT DO NOTHING;

-- --- SUPER_ADMIN: todas as permissões de plataforma ---
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'SUPER_ADMIN' AND p.code NOT IN ('order:create','order:read_own','delivery:update_own')
ON CONFLICT DO NOTHING;

-- --- DELIVERY: só o que foi designado a ele ---
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'DELIVERY' AND p.code IN ('branch:read','delivery:update_own')
ON CONFLICT DO NOTHING;

-- --- CUSTOMER: compra e acompanha o próprio pedido ---
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
-- `order:cancel` no CUSTOMER é restrito ao PRÓPRIO pedido por duas camadas
-- independentes: a política `orders_customer_isolation` (RLS) e a tabela de
-- transições, que só admite CUSTOMER cancelando a partir de PENDING.
WHERE r.code = 'CUSTOMER' AND p.code IN ('order:create','order:read_own','order:cancel')
ON CONFLICT DO NOTHING;
