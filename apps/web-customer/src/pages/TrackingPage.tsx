import { useParams } from 'react-router-dom';

export default function TrackingPage() {
  const { org, branch, orderId } = useParams();

  return (
    <div>
      <h1>Rastreamento do Pedido</h1>
      <p>Organização: {org}</p>
      <p>Unidade: {branch}</p>
      <p>Pedido ID: {orderId}</p>
      {/* Rastreamento será implementado aqui */}
    </div>
  );
}
