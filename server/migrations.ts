// ── Versioniertes Migrations-System ──────────────────────────────────────────
// Ergänzt (nicht ersetzt) die bestehenden idempotenten Inline-Patches in db.ts.
//
// Hintergrund: ensureSchema() in db.ts enthält 12+ CREATE TABLE und 60+ ALTER TABLE
// als Inline-Patches beim Boot – historisch gewachsen, nicht auditierbar.
// Dieses System führt eine schema_migrations-Tabelle ein:
//   - '000_baseline-inline-patches' markiert den Ist-Stand (die Inline-Patches
//     laufen unverändert weiter, sie sind idempotent und produktiv erprobt).
//   - NEUE Schema-Änderungen werden als nummerierte Migrationen in MIGRATIONS
//     registriert und genau einmal ausgeführt (auditierbar, reproduzierbar).
//
// Sicherheit für Railway-Boot: Eine fehlschlagende NEUE Migration wirft einen
// Fehler (fail-fast, damit der Deploy sichtbar scheitert), das Registrieren der
// Baseline selbst ist idempotent und kann nichts kaputtmachen.

export type SqlExecutor = (sql: string, params?: unknown[]) => Promise<unknown>;

interface Migration {
  id: string;          // z.B. '001' – streng aufsteigend
  name: string;        // z.B. 'add-xyz-index'
  up: (exec: SqlExecutor) => Promise<void>;
}

// ── Registrierte Migrationen (NEUE Schema-Änderungen hier eintragen) ─────────
const MIGRATIONS: Migration[] = [
  // Beispiel für zukünftige Migrationen:
  // {
  //   id: '001',
  //   name: 'add-orders-user-idx',
  //   up: async (exec) => {
  //     await exec(`CREATE INDEX IF NOT EXISTS idx_mosaic_orders_user ON mosaic_orders (user_id)`);
  //   },
  // },
];

const BASELINE_ID = '000';
const BASELINE_NAME = 'baseline-inline-patches';

/**
 * Führt ausstehende Migrationen aus. Wird am Ende von ensureSchema() in db.ts
 * aufgerufen (Executor wird injiziert, um eine zirkuläre Abhängigkeit zu vermeiden).
 * Gibt die IDs der in diesem Lauf neu angewendeten Migrationen zurück.
 */
export async function runMigrations(exec: SqlExecutor): Promise<string[]> {
  await exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Baseline registrieren (idempotent): dokumentiert, dass alle Inline-Patches
  // aus ensureSchema() als Ist-Stand gelten.
  await exec(
    `INSERT INTO schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [BASELINE_ID, BASELINE_NAME],
  );

  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    const res = await exec(`SELECT id FROM schema_migrations WHERE id = $1`, [m.id]);
    const rows = (res as { rows?: unknown[] })?.rows ?? [];
    if (rows.length > 0) continue; // bereits angewendet
    await m.up(exec);
    await exec(
      `INSERT INTO schema_migrations (id, name) VALUES ($1, $2)`,
      [m.id, m.name],
    );
    applied.push(`${m.id}_${m.name}`);
  }
  return applied;
}
