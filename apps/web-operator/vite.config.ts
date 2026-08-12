import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Servido pela API em /admin. Sem este base, os assets sairiam em /assets e
  // colidiriam com os do cardápio, que é servido pelo mesmo processo.
  base: '/admin/',
  server: {
    port: 3002,
    // Em desenvolvimento o SPA roda no Vite e a API noutra porta; o proxy evita
    // CORS e mantém as URLs iguais às de produção.
    proxy: { '/v1': 'http://localhost:3000' },
  },
});
