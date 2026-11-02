import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

/**
 * Tiny JSON key-value store. Postgres when DATABASE_URL (or POSTGRES_URL, which the Neon
 * integration on Vercel sets) is there, so every server instance
 * shares state; local JSON files otherwise, for zero-setup development.
 * `update` is a locked read-modify-write: SELECT … FOR UPDATE in Postgres, a per-key queue on disk.
 */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  update<T, R>(key: string, fallback: () => T, fn: (value: T) => R | Promise<R>): Promise<R>;
  /** Keys starting with `prefix` (live ones only). */
  keys(prefix: string): Promise<string[]>;
  /** Every live key starting with `prefix` with its value, in one read (for operator overviews). */
  entries<T>(prefix: string): Promise<[string, T][]>;
}

// — Postgres —

const g = globalThis as { __clPool?: Pool; __clSchema?: Promise<void> };

const databaseUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL;

/**
 * Supabase signs its certificates with its own CA, which Node doesn't trust, and pg treats
 * sslmode=require as "verify". Keep the connection encrypted but skip the CA check there.
 * Elsewhere (Neon) pg already verifies the certificate for prefer/require/verify-ca and logs a
 * SECURITY WARNING on every cold start; spelling it verify-full keeps that behavior, minus the warning.
 */
function pgConfig(url: string) {
  const u = new URL(url);
  if (/\.supabase\.(com|co)$/.test(u.hostname)) {
    u.searchParams.delete("sslmode");
    return { connectionString: u.toString(), ssl: { rejectUnauthorized: false } };
  }
  const mode = u.searchParams.get("sslmode");
  if (mode && ["prefer", "require", "verify-ca"].includes(mode) && !u.searchParams.has("uselibpqcompat")) u.searchParams.set("sslmode", "verify-full");
  return { connectionString: u.toString() };
}

function pool() {
  if (!g.__clPool) {
    g.__clPool = new Pool({ ...pgConfig(databaseUrl()!), max: 5, idleTimeoutMillis: 5000 });
    attachDatabasePool(g.__clPool);
  }
  return g.__clPool;
}

// The table keeps the product's earlier name: renaming it would orphan every existing install's data.
function ensureSchema() {
  g.__clSchema ??= pool()
    .query(
      `CREATE TABLE IF NOT EXISTS chieflooper_kv (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        expires_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    )
    .then(() => undefined)
    .catch((e) => {
      g.__clSchema = undefined;
      throw e;
    });
  return g.__clSchema;
}

const live = "(expires_at IS NULL OR expires_at > now())";

const postgres: KV = {
  async get<T>(key: string) {
    await ensureSchema();
    const r = await pool().query(`SELECT value FROM chieflooper_kv WHERE key = $1 AND ${live}`, [key]);
    return r.rows[0]?.value as T | undefined;
  },
  async set(key, value, ttlSeconds) {
    await ensureSchema();
    await pool().query(
      `INSERT INTO chieflooper_kv (key, value, expires_at, updated_at)
       VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(secs => $3::int) END, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [key, JSON.stringify(value), ttlSeconds ?? null],
    );
  },
  async delete(key) {
    await ensureSchema();
    await pool().query(`DELETE FROM chieflooper_kv WHERE key = $1`, [key]);
  },
  async keys(prefix) {
    await ensureSchema();
    const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
    const r = await pool().query(`SELECT key FROM chieflooper_kv WHERE key LIKE $1 AND ${live}`, [like]);
    return r.rows.map((row) => row.key as string);
  },
  async entries<T>(prefix: string) {
    await ensureSchema();
    const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
    const r = await pool().query(`SELECT key, value FROM chieflooper_kv WHERE key LIKE $1 AND ${live}`, [like]);
    return r.rows.map((row) => [row.key as string, row.value as T] as [string, T]);
  },
  async update(key, fallback, fn) {
    await ensureSchema();
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      // Make sure the row exists so FOR UPDATE has something to lock.
      await client.query(`INSERT INTO chieflooper_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(fallback())]);
      const r = await client.query(`SELECT value, ${live} AS alive FROM chieflooper_kv WHERE key = $1 FOR UPDATE`, [key]);
      const value = (r.rows[0]?.alive ? r.rows[0].value : fallback()) as Parameters<typeof fn>[0];
      const result = await fn(value);
      await client.query(`UPDATE chieflooper_kv SET value = $2, expires_at = NULL, updated_at = now() WHERE key = $1`, [key, JSON.stringify(value)]);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  },
};

// — Local files —

const DATA_DIR = process.env.LOOPER_DATA_DIR ?? process.env.GROKLOOPER_DATA_DIR ?? path.join(process.cwd(), "data");
const fileOf = (key: string) => path.join(DATA_DIR, "kv", `${encodeURIComponent(key)}.json`);
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}

async function readFile<T>(key: string): Promise<T | undefined> {
  try {
    const { value, expiresAt } = JSON.parse(await fs.readFile(fileOf(key), "utf8"));
    return expiresAt && expiresAt < Date.now() ? undefined : value;
  } catch {
    return undefined;
  }
}

async function writeFile(key: string, value: unknown, ttlSeconds?: number) {
  const file = fileOf(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined }), { mode: 0o600 });
  await fs.rename(tmp, file);
}

const files: KV = {
  get: (key) => (queues.get(key) ?? Promise.resolve()).then(() => readFile(key)),
  set: (key, value, ttl) => serialized(key, () => writeFile(key, value, ttl)),
  delete: (key) => serialized(key, () => fs.rm(fileOf(key), { force: true })),
  keys: async (prefix) => {
    const names = await fs.readdir(path.join(DATA_DIR, "kv")).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith(".json")).map((n) => decodeURIComponent(n.slice(0, -5))).filter((k) => k.startsWith(prefix));
  },
  entries: async <T,>(prefix: string) => {
    const keys = await files.keys(prefix);
    const values = await Promise.all(keys.map((k) => files.get<T>(k)));
    return keys.flatMap((k, i) => (values[i] === undefined ? [] : [[k, values[i]] as [string, T]]));
  },
  update: (key, fallback, fn) =>
    serialized(key, async () => {
      const value = (await readFile<ReturnType<typeof fallback>>(key)) ?? fallback();
      const result = await fn(value);
      await writeFile(key, value);
      return result;
    }),
};

export const kv: KV = databaseUrl() ? postgres : files;
export const usingPostgres = () => !!databaseUrl();
