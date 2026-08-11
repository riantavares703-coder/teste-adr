import { useParams } from 'react-router-dom';

export default function MenuPage() {
  const { org, branch } = useParams();

  return (
    <div>
      <h1>Cardápio</h1>
      <p>Organização: {org}</p>
      <p>Unidade: {branch}</p>
      {/* Menu será implementado aqui */}
    </div>
  );
}
