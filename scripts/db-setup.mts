// Applies db/schema.sql. Every statement uses "if not exists", so it's safe to rerun.
import { readFileSync } from "node:fs";
import { getSql } from "@/lib/db";

const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
const statements = schema
  .replace(/--.*$/gm, "")
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter(Boolean);

const sql = getSql();
for (const statement of statements) await sql.query(statement);

const tables = await sql`
  select table_name from information_schema.tables
  where table_schema = 'public' order by table_name`;
console.log(`Applied ${statements.length} statements. Tables: ${tables.map((t) => t.table_name).join(", ")}`);
