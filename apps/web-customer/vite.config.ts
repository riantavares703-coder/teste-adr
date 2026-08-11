import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  /**
   * As PÁGINAS deste app são servidas em /:organizacao/:unidade, mas os ASSETS
   * saem daqui — em caminho absoluto e fixo, para funcionarem em qualquer
   * profundidade de rota e não colidirem com os do painel do operador.
   */
  base: '/storefront/',
  server: {
    port: 3001,
    proxy: { '/v1': 'http://localhost:3000' },
  },
});
