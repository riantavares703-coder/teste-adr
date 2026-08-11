import { useParams } from 'react-router-dom';

export default function CheckoutPage() {
  const { org, branch } = useParams();

  return (
    <div>
      <h1>Checkout</h1>
      <p>Organização: {org}</p>
      <p>Unidade: {branch}</p>
      {/* Checkout será implementado aqui */}
    </div>
  );
}
