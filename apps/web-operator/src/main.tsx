import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* A API serve este SPA sob /admin, então o router precisa do mesmo prefixo. */}
    <BrowserRouter basename="/admin">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
