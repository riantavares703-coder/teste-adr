import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ThemeToggle } from '@plataforma/ui-web';
import { SessionProvider, useSession } from './session';
import { LoginPage } from './pages/LoginPage';
import { OrdersPage } from './pages/OrdersPage';
import { SharePage } from './pages/SharePage';
import { MenuEditorPage } from './pages/MenuEditorPage';
import { DashboardPage } from './pages/DashboardPage';
import { StoreSettingsPage } from './pages/StoreSettingsPage';
import { AccountPage } from './pages/AccountPage';

export function App() {
  return (
    <SessionProvider fallback={(onSignedIn) => <LoginPage onSignedIn={onSignedIn} />}>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { profile, branch, branches, selectBranch, signOut, can } = useSession();
  const { pathname } = useLocation();

  // No celular o menu rola de lado: leva a aba da tela atual para a vista.
  useEffect(() => {
    document
      .querySelector('.admin__nav a.active')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [pathname]);

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

        {/* Só aparece o que o servidor concedeu. Esconder é conveniência de
            tela; quem recusa a operação continua sendo a API. */}
        <nav className="admin__nav">
          <NavLink to="/pedidos">Pedidos</NavLink>
          {can('report:read') ? <NavLink to="/faturamento">Faturamento</NavLink> : null}
          {can('product:read') ? <NavLink to="/cardapio">Cardápio</NavLink> : null}
          {can('settings:read') ? <NavLink to="/loja">Horário</NavLink> : null}
          <NavLink to="/compartilhar">Compartilhar</NavLink>
        </nav>

        <div className="admin__user">
          <NavLink to="/conta" className="admin__account" title="Minha conta e troca de senha">
            {profile.fullName}
          </NavLink>
          <ThemeToggle />
          <button type="button" className="ui-btn ui-btn--ghost" onClick={signOut}>
            Sair
          </button>
        </div>
      </header>

      <main className="admin__main">
        <Routes>
          <Route path="/pedidos" element={<OrdersPage />} />
          <Route path="/conta" element={<AccountPage />} />
          <Route path="/faturamento" element={<DashboardPage />} />
          <Route path="/cardapio" element={<MenuEditorPage />} />
          <Route path="/loja" element={<StoreSettingsPage />} />
          <Route path="/compartilhar" element={<SharePage />} />
          {/* A fila é a tela de trabalho: é onde o operador deve cair. */}
          <Route path="*" element={<Navigate to="/pedidos" replace />} />
        </Routes>
      </main>
    </div>
  );
}
