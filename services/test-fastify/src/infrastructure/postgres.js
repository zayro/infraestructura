import pg from "pg";
import { trace } from "@opentelemetry/api";
import { logError } from "./observability.js";

const { Pool } = pg;

const ITEM_COLUMNS = "id, name, created_at";
const EVENT_COLUMNS = "event_id, name, received_at, updated_at";

const toItem = (row) => ({ id: row.id, name: row.name, createdAt: row.created_at });
const toEvent = (row) => ({
  eventId: row.event_id,
  name: row.name,
  receivedAt: row.received_at,
  updatedAt: row.updated_at,
});

// Registra db_write_ok / db_write_failed (con trace_id) dentro del span activo.
async function loggedWrite(log, table, operation, fields, fn) {
  trace.getActiveSpan()?.setAttributes({ "db.sql.table": table, "db.operation": operation });
  try {
    const result = await fn();
    log("db_write_ok", { table, operation, ...fields });
    return result;
  } catch (err) {
    log(
      "db_write_failed",
      { table, operation, ...fields, error_type: err.code ?? err.name, error: err.message },
      "ERROR"
    );
    throw err;
  }
}

export function createPool(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", (err) => logError("pg_pool_error", err));
  return pool;
}

export async function ensureSchema(pool) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS node_items (" +
      "id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS node_events (" +
      "event_id UUID PRIMARY KEY, name TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
  await pool.query("ALTER TABLE node_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ");
}

export class PostgresItemsRepository {
  constructor(pool, tracing, log) {
    this.pool = pool;
    this.tracing = tracing;
    this.log = log;
  }

  async create(name) {
    const { rows } = await this.tracing.withSpan("node.db_insert", { "db.system": "postgresql" }, () =>
      loggedWrite(this.log, "node_items", "INSERT", {}, () =>
        this.pool.query(`INSERT INTO node_items (name) VALUES ($1) RETURNING ${ITEM_COLUMNS}`, [name])
      )
    );
    return toItem(rows[0]);
  }

  async listRecent(limit) {
    const { rows } = await this.tracing.withSpan("node.db_select", { "db.system": "postgresql" }, () =>
      this.pool.query(`SELECT ${ITEM_COLUMNS} FROM node_items ORDER BY id DESC LIMIT $1`, [limit])
    );
    return rows.map(toItem);
  }
}

export class PostgresEventsRepository {
  constructor(pool, tracing, log) {
    this.pool = pool;
    this.tracing = tracing;
    this.log = log;
  }

  // `write` ({ operation, eventId }) activa el log de escritura para INSERT/UPDATE/DELETE.
  async #query(spanName, text, params, write) {
    return this.tracing.withSpan(spanName, { "db.system": "postgresql" }, () => {
      const run = () => this.pool.query(text, params);
      return write
        ? loggedWrite(this.log, "node_events", write.operation, { event_id: write.eventId }, run)
        : run();
    });
  }

  async create({ eventId, name }) {
    const { rows } = await this.#query(
      "node.db_insert_event",
      `INSERT INTO node_events (event_id, name) VALUES ($1, $2) RETURNING ${EVENT_COLUMNS}`,
      [eventId, name],
      { operation: "INSERT", eventId }
    );
    return toEvent(rows[0]);
  }

  async createIfAbsent({ eventId, name }) {
    await this.#query(
      "node.db_insert_event",
      "INSERT INTO node_events (event_id, name) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
      [eventId, name],
      { operation: "INSERT", eventId }
    );
  }

  async get(eventId) {
    const { rows } = await this.#query(
      "node.db_select_event",
      `SELECT ${EVENT_COLUMNS} FROM node_events WHERE event_id = $1`,
      [eventId]
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async listRecent(limit) {
    const { rows } = await this.#query(
      "node.db_select_events",
      `SELECT ${EVENT_COLUMNS} FROM node_events ORDER BY received_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(toEvent);
  }

  async update(eventId, name) {
    const { rows } = await this.#query(
      "node.db_update_event",
      `UPDATE node_events SET name = $1, updated_at = now() WHERE event_id = $2 RETURNING ${EVENT_COLUMNS}`,
      [name, eventId],
      { operation: "UPDATE", eventId }
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async delete(eventId) {
    const { rowCount } = await this.#query(
      "node.db_delete_event",
      "DELETE FROM node_events WHERE event_id = $1",
      [eventId],
      { operation: "DELETE", eventId }
    );
    return rowCount > 0;
  }
}
