require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./postgres");

async function main() {
  const sql = fs.readFileSync(
    path.join(__dirname, "postgres-schema.sql"),
    "utf8"
  );

  const statements = sql
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const statement of statements) {
      await client.query(statement);
    }

    await client.query("COMMIT");
    console.log("PostgreSQL schema created successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch(err => {
    console.error("Schema setup failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
