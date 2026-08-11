-- =============================================================================
--  IDENTIDADE VISUAL COMPLETA + SUPORTE A INDICADORES CONSOLIDADOS
--
--  Prompt 03, itens 1 a 4: o administrador configura nome, logo, ícone, cinco
--  cores, tipografia e gradiente. Prompt 03, item 8: a franquia enxerga
--  indicadores agregados por unidade.
-- =============================================================================

-- --- 1. Tipos fechados para tipografia e gradiente ---------------------------
--
-- Poderiam ser `text` com CHECK. São TIPOS porque a lista é a defesa contra a
-- exigência do item 2 ("não permitir injeção de CSS"): o banco recusa qualquer
-- valor fora dela, mesmo que alguém escreva por fora da aplicação. O app, por
-- sua vez, só sabe desenhar os tokens que conhece, e cai no padrão nos demais.
-- São duas barreiras independentes para o mesmo campo.

CREATE TYPE brand_font AS ENUM (
    'INTER', 'POPPINS', 'MONTSERRAT', 'ROBOTO', 'NUNITO', 'DM_SANS'
);

CREATE TYPE gradient_style AS ENUM (
    'NONE', 'VERTICAL', 'HORIZONTAL', 'DIAGONAL', 'DIAGONAL_REVERSE'
);

-- --- 2. Colunas de aparência -------------------------------------------------

ALTER TABLE branding_settings
    ADD COLUMN accent_color     char(7) CHECK (accent_color     ~ '^#[0-9a-fA-F]{6}$'),
    ADD COLUMN text_color       char(7) CHECK (text_color       ~ '^#[0-9a-fA-F]{6}$'),
    ADD COLUMN background_color char(7) CHECK (background_color ~ '^#[0-9a-fA-F]{6}$'),
    ADD COLUMN card_color       char(7) CHECK (card_color       ~ '^#[0-9a-fA-F]{6}$'),
    ADD COLUMN gradient_from    char(7) CHECK (gradient_from    ~ '^#[0-9a-fA-F]{6}$'),
    ADD COLUMN gradient_to      char(7) CHECK (gradient_to      ~ '^#[0-9a-fA-F]{6}$'),
    ADD COLUMN font_token       brand_font,
    ADD COLUMN gradient_style   gradient_style,
    -- Ícone do app / favicon quando houver vitrine web. Chave de storage
    -- privado, como toda mídia: nunca caminho informado pelo usuário.
    ADD COLUMN icon_storage_key text,
    -- Quem mexeu na identidade visual da loja. Aparência é configuração de
    -- negócio: se o cardápio de uma franquia amanhecer com a cor errada,
    -- precisa haver a quem perguntar.
    ADD COLUMN updated_by       uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN branding_settings.font_token IS
    'Token de fonte da lista fechada. Nunca um nome de família livre.';
COMMENT ON COLUMN branding_settings.updated_by IS
    'Último usuário que alterou a aparência (trilha em audit_logs).';

-- --- 3. Índices para os indicadores consolidados -----------------------------
--
-- O painel da franquia agrega pedidos por unidade e por período. Sem índice,
-- isso vira varredura sequencial em `orders` — a tabela que mais cresce.
--
-- Os índices existentes não servem a este acesso: `orders_active_queue_idx`
-- começa por `branch_id` (fila de UMA unidade) e não ajuda quando a franquia
-- soma TODAS as unidades dela em um intervalo.
--
-- `order_items` já tem índices por `order_id` e por `product_id` — suficientes
-- para o "mais vendidos", que caminha de `orders` para `order_items`.

CREATE INDEX orders_org_placed_idx
    ON orders (organization_id, placed_at DESC);

-- Faturamento conta apenas pedidos que chegaram ao fim com sucesso. O índice
-- parcial reflete exatamente o predicado da consulta de faturamento, e fica
-- pequeno porque exclui pedidos em andamento, cancelados e expirados.
CREATE INDEX orders_org_revenue_idx
    ON orders (organization_id, branch_id, placed_at)
    WHERE status IN ('DELIVERED', 'PICKED_UP');

-- --- 4. O operador enxerga os indicadores DA UNIDADE DELE ---------------------
--
-- Item 8: "O operador comum deve visualizar apenas a unidade autorizada" — o
-- que pressupõe que ele visualize alguma coisa. `report:read` concede a rota;
-- QUAIS unidades entram na conta é decidido por AnalyticsService.resolveScope,
-- a partir do escopo do usuário, e reforçado pela RLS. Sem escopo de
-- organização, o operador nunca soma a unidade vizinha.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'OPERATOR' AND p.code = 'report:read'
ON CONFLICT DO NOTHING;

-- --- 5. Aparência padrão para as unidades já existentes -----------------------
--
-- Sem isto, uma unidade criada antes desta migração teria todas as cores nulas
-- e o app cairia no padrão da plataforma. Funciona — mas o administrador abriria
-- a tela de aparência com os campos vazios, sem saber o que está no ar. Preencher
-- com o padrão torna a tela honesta: o que aparece é o que está valendo.
UPDATE branding_settings
   SET primary_color    = COALESCE(primary_color,    '#e11d48'),
       secondary_color  = COALESCE(secondary_color,  '#0f172a'),
       accent_color     = COALESCE(accent_color,     '#f59e0b'),
       text_color       = COALESCE(text_color,       '#0f172a'),
       background_color = COALESCE(background_color, '#f6f7f9'),
       card_color       = COALESCE(card_color,       '#ffffff'),
       gradient_from    = COALESCE(gradient_from,    '#e11d48'),
       gradient_to      = COALESCE(gradient_to,      '#f59e0b'),
       font_token       = COALESCE(font_token,       'INTER'::brand_font),
       gradient_style   = COALESCE(gradient_style,   'DIAGONAL'::gradient_style);
