import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { query, closePool } from "./index";

async function ensureMigrationTable(): Promise<void> {
  await query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function hasMigration(version: string): Promise<boolean> {
  const result = await query<{ version: string }>(
    "select version from schema_migrations where version = $1",
    [version]
  );
  return (result.rowCount ?? 0) > 0;
}

async function recordMigration(version: string): Promise<void> {
  await query("insert into schema_migrations (version) values ($1)", [version]);
}

async function run(): Promise<void> {
  const migrationsDir = path.join(__dirname, "migrations");
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await ensureMigrationTable();

  for (const file of files) {
    if (await hasMigration(file)) {
      console.log(`Skipping ${file}`);
      continue;
    }

    console.log(`Applying ${file}`);
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await query(sql);
    await recordMigration(file);
  }
}

run()
  .then(async () => {
    await closePool();
    console.log("Migrations complete");
  })
  .catch(async (error) => {
    await closePool();
    console.error(error);
    process.exit(1);
  });
