import React, { createContext, useContext, useMemo, useState } from 'react';
import {
  addToCart,
  changeQuantity,
  clearCart,
  EMPTY_CART,
  priceCart,
  removeLine,
  type CartOption,
  type CartState,
  type MenuProduct,
} from '@plataforma/client';

interface CartValue {
  cart: CartState;
  add: (input: {
    product: MenuProduct;
    branchId: string;
    organizationSlug: string;
    branchSlug: string;
    quantity: number;
    selectedOptions: CartOption[];
    notes?: string;
  }) => void;
  changeQty: (key: string, delta: number) => void;
  remove: (key: string) => void;
  clear: () => void;
  totals: (deliveryFeeCents?: number) => ReturnType<typeof priceCart>;
  count: number;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartState>(EMPTY_CART);

  const value = useMemo<CartValue>(
    () => ({
      cart,
      add: (input) => setCart((current) => addToCart(current, input)),
      changeQty: (key, delta) => setCart((current) => changeQuantity(current, key, delta)),
      remove: (key) => setCart((current) => removeLine(current, key)),
      clear: () => setCart(clearCart()),
      totals: (deliveryFeeCents = 0) => priceCart(cart, deliveryFeeCents),
      count: cart.lines.reduce((acc, l) => acc + l.quantity, 0),
    }),
    [cart],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart precisa estar dentro de <CartProvider>');
  return value;
}
