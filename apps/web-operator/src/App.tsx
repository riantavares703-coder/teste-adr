import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { LoginPage } from './pages/LoginPage';
import { OrdersPage } from './pages/OrdersPage';
import { SharePage } from './pages/SharePage';

export function App() {
  return (
    <SessionProvider fallback={(onSignedIn) => <LoginPage onSignedIn={onSignedIn} />}>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { profile, branch, branches, selectBranch, signOut } = useSession();

  return (
    <div className="admin">
      <header className="admin__top">
        <div className="admin__brand">
          <strong>{branch.name}</strong>
          {branches.length > 1 ? (
            <select
              aria-label="Unidade"
              value={branch.id}
              onChange={(e) => selectBranch(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        <nav className="admin__nav">
          <NavLink to="/pedidos">Pedidos</NavLink>
          <NavLink to="/cardapio">Cardápio do cliente</NavLink>
        </nav>

        <div className="admin__user">
          <span>{profile.fullName}</span>
          <button type="button" className="ui-btn ui-btn--ghost" onClick={signOut}>
            Sair
          </button>
        </div>
      </header>

      <main className="admin__main">
        <Routes>
          <Route path="/pedidos" element={<OrdersPage />} />
          <Route path="/cardapio" element={<SharePage />} />
          {/* A fila é a tela de trabalho: é onde o operador deve cair. */}
          <Route path="*" element={<Navigate to="/pedidos" replace />} />
        </Routes>
      </main>
    </div>
  );
}
