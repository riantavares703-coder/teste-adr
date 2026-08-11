import { Routes, Route } from 'react-router-dom';
import MenuPage from './pages/MenuPage';
import CheckoutPage from './pages/CheckoutPage';
import TrackingPage from './pages/TrackingPage';
import './App.css';

export default function App() {
  return (
    <Routes>
      <Route path="/:org/:branch/menu" element={<MenuPage />} />
      <Route path="/:org/:branch/checkout" element={<CheckoutPage />} />
      <Route path="/:org/:branch/tracking/:orderId" element={<TrackingPage />} />
      <Route path="/" element={<div>Cardápio Virtual</div>} />
    </Routes>
  );
}
