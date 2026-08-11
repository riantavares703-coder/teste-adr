import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Testes de integração compartilham um único banco: rodar em série evita
    // que a limpeza de um teste apague a massa de outro. A concorrência REAL
    // que nos interessa (vários clientes na última unidade) é exercitada
    // DENTRO dos testes, com conexões paralelas de verdade.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
  },
});
