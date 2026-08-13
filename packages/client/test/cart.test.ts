import { describe, expect, it } from 'vitest';
import {
  addToCart,
  cartItemCount,
  changeQuantity,
  clearCart,
  EMPTY_CART,
  priceCart,
  removeLine,
  toOrderItems,
  validateSelection,
  type CartState,
} from '../src/cart.js';
import type { MenuProduct, ModifierGroup } from '../src/api.js';

const burger: MenuProduct = {
  id: '11111111-1111-7111-8111-111111111111',
  name: 'X-Burger',
  description: 'Pão brioche',
  priceCents: 2990,
  categoryId: 'c1',
  isFeatured: true,
  allowsCustomerNotes: true,
  hasOptions: false,
  imageUrl: '/v1/media/a.webp',
  thumbUrl: '/v1/media/a_sm.webp',
  availability: { status: 'AVAILABLE', isPurchasable: true, availableQuantity: null },
};

const limited: MenuProduct = {
  ...burger,
  id: '22222222-2222-7222-8222-222222222222',
  name: 'Coca-Cola 350ml',
  priceCents: 800,
  availability: { status: 'AVAILABLE', isPurchasable: true, availableQuantity: 3 },
};

const ctx = {
  branchId: 'b1',
  organizationSlug: 'acme',
  branchSlug: 'centro',
};

describe('carrinho', () => {
  it('adiciona produto e calcula subtotal', () => {
    const cart = addToCart(EMPTY_CART, {
      ...ctx,
      product: burger,
      quantity: 2,
      selectedOptions: [],
    });
    expect(cartItemCount(cart)).toBe(2);
    expect(priceCart(cart)!.subtotalCents).toBe(5980);
  });

  it('soma quantidade ao adicionar o MESMO item de novo', () => {
    let cart = addToCart(EMPTY_CART, { ...ctx, product: burger, quantity: 1, selectedOptions: [] });
    cart = addToCart(cart, { ...ctx, product: burger, quantity: 2, selectedOptions: [] });
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.quantity).toBe(3);
  });

  it('mesmo produto com adicionais diferentes vira linha separada', () => {
    let cart = addToCart(EMPTY_CART, { ...ctx, product: burger, quantity: 1, selectedOptions: [] });
    cart = addToCart(cart, {
      ...ctx,
      product: burger,
      quantity: 1,
      selectedOptions: [{ id: 'o1', name: 'Bacon', priceDeltaCents: 500, groupName: 'Adicionais' }],
    });
    expect(cart.lines).toHaveLength(2);
    expect(priceCart(cart)!.subtotalCents).toBe(2990 + 3490);
  });

  it('respeita o estoque disponível ao aumentar a quantidade', () => {
    let cart = addToCart(EMPTY_CART, { ...ctx, product: limited, quantity: 3, selectedOptions: [] });
    cart = changeQuantity(cart, cart.lines[0]!.key, 5);
    // Disponível é 3: o app não deixa passar disso (o servidor recusaria de todo jeito).
    expect(cart.lines[0]!.quantity).toBe(3);
  });

  it('diminuir até zero remove a linha', () => {
    let cart = addToCart(EMPTY_CART, { ...ctx, product: burger, quantity: 1, selectedOptions: [] });
    cart = changeQuantity(cart, cart.lines[0]!.key, -1);
    expect(cart.lines).toHaveLength(0);
  });

  it('remover linha específica', () => {
    let cart = addToCart(EMPTY_CART, { ...ctx, product: burger, quantity: 1, selectedOptions: [] });
    cart = addToCart(cart, { ...ctx, product: limited, quantity: 1, selectedOptions: [] });
    cart = removeLine(cart, cart.lines[0]!.key);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.productId).toBe(limited.id);
  });

  it('trocar de loja limpa o carrinho (pedido pertence a UMA unidade)', () => {
    let cart = addToCart(EMPTY_CART, { ...ctx, product: burger, quantity: 2, selectedOptions: [] });
    cart = addToCart(cart, {
      ...ctx,
      branchId: 'b2',
      product: limited,
      quantity: 1,
      selectedOptions: [],
    });
    expect(cart.branchId).toBe('b2');
    expect(cart.lines).toHaveLength(1);
  });

  it('taxa de entrega entra no total, mas não no subtotal', () => {
    const cart = addToCart(EMPTY_CART, { ...ctx, product: burger, quantity: 1, selectedOptions: [] });
    const priced = priceCart(cart, 700)!;
    expect(priced.subtotalCents).toBe(2990);
    expect(priced.totalCents).toBe(3690);
  });

  it('carrinho vazio não tem preço', () => {
    expect(priceCart(clearCart())).toBeNull();
  });

  it('converte para o payload do pedido sem NENHUM valor monetário', () => {
    const cart: CartState = addToCart(EMPTY_CART, {
      ...ctx,
      product: burger,
      quantity: 2,
      selectedOptions: [{ id: 'o1', name: 'Bacon', priceDeltaCents: 500, groupName: 'Add' }],
      notes: 'sem cebola',
    });
    const items = toOrderItems(cart);
    expect(items).toEqual([
      { productId: burger.id, quantity: 2, optionIds: ['o1'], notes: 'sem cebola' },
    ]);
    // Nenhuma chave de preço vai para o servidor.
    const serialized = JSON.stringify(items);
    for (const forbidden of ['price', 'Cents', 'total']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('validação de adicionais', () => {
  const groups: ModifierGroup[] = [
    {
      id: 'g1',
      name: 'Ponto da carne',
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      options: [
        { id: 'p1', name: 'Mal passado', priceDeltaCents: 0 },
        { id: 'p2', name: 'Ao ponto', priceDeltaCents: 0 },
      ],
    },
    {
      id: 'g2',
      name: 'Adicionais',
      minSelect: 0,
      maxSelect: 2,
      isRequired: false,
      options: [
        { id: 'a1', name: 'Bacon', priceDeltaCents: 500 },
        { id: 'a2', name: 'Ovo', priceDeltaCents: 300 },
        { id: 'a3', name: 'Cheddar', priceDeltaCents: 400 },
      ],
    },
  ];

  it('exige o grupo obrigatório', () => {
    const result = validateSelection(groups, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Ponto da carne');
  });

  it('recusa mais opções que o máximo', () => {
    const result = validateSelection(groups, ['p1', 'a1', 'a2', 'a3']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('máximo 2');
  });

  it('aceita seleção válida', () => {
    expect(validateSelection(groups, ['p1', 'a1']).ok).toBe(true);
  });
});
