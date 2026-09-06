import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import bcrypt from "bcryptjs";
import pg from "pg";
import fs from "node:fs";

const { Pool } = pg;
const args = process.argv.slice(2);
const rl = readline.createInterface({ input, output });

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  const email = (args[0] || await rl.question("Email: ")).trim().toLowerCase();
  const password = args[1] || await rl.question("Password: ");
  const fullName = (args[2] || await rl.question("Full name: ")).trim();
  const role = (args[3] || await rl.question("Role (staff/admin) [staff]: ")).trim().toLowerCase() || "staff";
  if (!email || !password || !fullName) throw new Error("Email, password, and full name are required.");
  if (!/^(staff|admin)$/.test(role)) throw new Error("Role must be staff or admin.");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "true"
      ? {
          rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false",
          ...(process.env.PGSSL_CA_PATH ? { ca: fs.readFileSync(process.env.PGSSL_CA_PATH, "utf8") } : {}),
        }
      : false,
  });
  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true
       RETURNING id`,
      [email, hash],
    );
    await client.query(
      `INSERT INTO profiles (id, full_name, role) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, active = true`,
      [user.rows[0].id, fullName, role],
    );
    await client.query("COMMIT");
    console.log(`User ready: ${email} (${role})`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
} finally {
  rl.close();
}
