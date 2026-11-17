require("dotenv").config();

const Database = require("better-sqlite3");
const path = require("path");
const pool = require("./postgres");

const tables = [
  "candidate_sequence",
  "users",
  "portal_admins",
  "portal_admin_audit",
  "it_study_materials",
  "it_practice_questions",
  "student_exam_papers",
  "student_exam_questions",
  "student_exam_attempts",
  "portal_written_questions"
];

const identityTables = tables.filter(t => t !== "candidate_sequence");

async function main() {
  const sqlite = new Database(
    path.join(__dirname, "tattva.db"),
    { readonly: true }
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Refuse to overwrite anything already in PostgreSQL.
    for (const table of tables) {
      const result = await client.query(
        `SELECT COUNT(*)::int AS total FROM "${table}"`
      );

      if (result.rows[0].total !== 0) {
        throw new Error(
          `PostgreSQL table ${table} is not empty. Migration stopped safely.`
        );
      }
    }

    // Copy all existing SQLite records.
    for (const table of tables) {
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();

      for (const row of rows) {
        const columns = Object.keys(row);
        const values = Object.values(row);

        if (columns.length === 0) continue;

        const columnSQL = columns.map(c => `"${c}"`).join(", ");
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

        await client.query(
          `INSERT INTO "${table}" (${columnSQL}) VALUES (${placeholders})`,
          values
        );
      }

      console.log(`${table}: copied ${rows.length} records`);
    }

    // Reset PostgreSQL identity sequences to match imported IDs.
    for (const table of identityTables) {
      await client.query(
        `SELECT setval(
          pg_get_serial_sequence($1, 'id'),
          GREATEST(COALESCE(MAX(id), 1), 1),
          MAX(id) IS NOT NULL
        ) FROM "${table}"`,
        [table]
      );
    }

    // Verify every table before committing.
    console.log("\nPostgreSQL verification:");

    for (const table of tables) {
      const sourceCount = sqlite
        .prepare(`SELECT COUNT(*) AS total FROM "${table}"`)
        .get().total;

      const target = await client.query(
        `SELECT COUNT(*)::int AS total FROM "${table}"`
      );

      const targetCount = target.rows[0].total;

      if (sourceCount !== targetCount) {
        throw new Error(`Record count mismatch in ${table}`);
      }

      console.log(`${table}: ${targetCount} records - MATCH`);
    }

    await client.query("COMMIT");
    console.log("\nMigration completed and committed successfully.");

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    sqlite.close();
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error("\nMigration stopped:", error.message);
  process.exitCode = 1;
});


