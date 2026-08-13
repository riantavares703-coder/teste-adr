import { Navigate, Route, Routes } from 'react-router-dom';
import { CartProvider } from './cart-context';
import { StoreProvider } from './store-context';
import { MenuPage } from './pages/MenuPage';
import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { OrderPage } from './pages/OrderPage';

/**
 * CARDÁPIO DO CLIENTE.
 *
 * O cliente chega por QR code, sem app instalado e sem conta. Por isso a loja
 * vem da URL (/:organizacao/:unidade) e não de uma seleção — quem escaneia o
 * código do balcão já escolheu a loja ao entrar nela.
 */
export function App() {
  return (
    <Routes>
      <Route
        path=":organizationSlug/:branchSlug/*"
        element={
          <StoreProvider>
            <CartProvider>
              <Routes>
                <Route index element={<MenuPage />} />
                <Route path="carrinho" element={<CartPage />} />
                <Route path="checkout" element={<CheckoutPage />} />
                <Route path="pedido/:orderId" element={<OrderPage />} />
                <Route path="*" element={<Navigate to="." replace />} />
              </Routes>
            </CartProvider>
          </StoreProvider>
        }
      />
      <Route
        path="*"
        element={
          <main className="ui-state">
            <span className="ui-state__icon" aria-hidden="true">
              🍽️
            </span>
            <h3>Cardápio não encontrado</h3>
            <p>Escaneie o QR code da loja para abrir o cardápio dela.</p>
          </main>
        }
      />
    </Routes>
  );
}
