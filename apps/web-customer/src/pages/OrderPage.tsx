import { useParams } from 'react-router-dom';
import { EmptyState } from '@plataforma/ui-web';

/**
 * ACOMPANHAMENTO DO PEDIDO.
 *
 * Depende do envio de pedido, que aguarda a decisão sobre identificação do
 * cliente. A rota já existe para que o link enviado ao cliente não quebre.
 */
export function OrderPage() {
  const { orderId } = useParams();

  return (
    <main className="store">
      <EmptyState
        icon="⏳"
        title="Acompanhamento em construção"
        description={`Pedido ${orderId ?? ''}`}
      />
    </main>
  );
}
