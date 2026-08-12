import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  EMPTY_CART,
  addToCart,
  cartItemCount,
  changeQuantity,
  clearCart,
  priceCart,
  removeLine,
  type CartState,
} from '@plataforma/client';
import { useStore } from './store-context';

/**
 * Carrinho.
 *
 * A matemática toda vem de `@plataforma/client` — a mesma que os testes cobrem.
 * Este arquivo cuida apenas de estado de tela e de sobreviver a um recarregar
 * de página (o cliente troca de aba, o navegador descarta a aba, ele volta).
 *
 * O total mostrado aqui é ESTIMATIVA. Quem cobra é o servidor, que recalcula do
 * zero no fechamento do pedido.
 */
type AddInput = Parameters<typeof addToCart>[1];

interface CartValue {
  cart: CartState;
  count: number;
  subtotalCents: number;
  add: (input: AddInput) => void;
  changeQty: (key: string, delta: number) => void;
  remove: (key: string) => void;
  clear: () => void;
}

const CartContext = createContext<CartValue | null>(null);

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart precisa estar dentro de <CartProvider>');
  return value;
}

export function CartProvider({ children }: { children: ReactNode }) {
  const { menu } = useStore();
  // Uma chave por unidade: o carrinho de uma loja não pode vazar para outra,
  // onde os produtos e os preços são outros.
  const storageKey = `cart:${menu.branch.id}`;

  const [cart, setCart] = useState<CartState>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? (JSON.parse(saved) as CartState) : EMPTY_CART;
    } catch {
      return EMPTY_CART;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(cart));
    } catch {
      // Modo privativo pode recusar escrita: o carrinho segue em memória.
    }
  }, [cart, storageKey]);

  const value = useMemo<CartValue>(
    () => ({
      cart,
      count: cartItemCount(cart),
      subtotalCents: priceCart(cart)?.subtotalCents ?? 0,
      add: (input) => setCart((current) => addToCart(current, input)),
      changeQty: (key, delta) => setCart((current) => changeQuantity(current, key, delta)),
      remove: (key) => setCart((current) => removeLine(current, key)),
      clear: () => setCart(clearCart()),
    }),
    [cart],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
