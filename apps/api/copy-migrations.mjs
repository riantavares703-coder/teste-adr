import { cpSync } from 'node:fs';

/**
 * `tsc` só compila .ts — as migrações são .sql lidas em runtime por
 * `dist/db/migrate.js` a partir da própria pasta onde o arquivo compilado
 * mora. Sem esta cópia, o build fica com a metade que roda mas sem a metade
 * que ela precisa ler.
 */
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
