import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Migrador simples e explícito: aplica arquivos .sql em ordem, cada um em sua
 * própria transação, registrando o que já rodou.
 *
 * Por que não um gerador de migração de ORM: o schema depende de triggers,
 * políticas de RLS, constraints de exclusão e FK compostas com
 * `ON DELETE SET NULL (coluna)` — nenhum gerador expressa isso (ADR-0004).
 */
export async function runMigrations(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (rows.length > 0) continue;

      const contents = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(contents);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migração ${file}: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.end();
  }

  return applied;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não definida');
    process.exit(1);
  }
  runMigrations(url)
    .then((applied) => {
      console.log(
        applied.length > 0
          ? `Migrações aplicadas: ${applied.join(', ')}`
          : 'Nenhuma migração pendente.',
      );
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
