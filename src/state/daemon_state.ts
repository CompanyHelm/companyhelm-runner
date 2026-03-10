import { eq } from "drizzle-orm";
import { initDb } from "./db.js";
import { daemonState } from "./schema.js";
import { isProcessRunning } from "../utils/process.js";

export const RUNNER_DAEMON_STATE_ID = "runner";

export interface CurrentDaemonState {
  id: string;
  pid: number | null;
  logPath: string | null;
  startedAt: string;
  updatedAt: string;
}

export async function readCurrentDaemonState(stateDbPath: string): Promise<CurrentDaemonState | null> {
  const { db, client } = await initDb(stateDbPath);

  try {
    const existing = await db.select().from(daemonState).where(eq(daemonState.id, RUNNER_DAEMON_STATE_ID)).all();
    const row = existing[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      pid: row.pid ?? null,
      logPath: row.logPath ?? null,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
    };
  } finally {
    client.close();
  }
}

export async function claimCurrentDaemonState(stateDbPath: string, pid: number, logPath: string): Promise<void> {
  const now = new Date().toISOString();
  const { client } = await initDb(stateDbPath);

  try {
    await client.execute("BEGIN IMMEDIATE");
    try {
      const existing = await client.execute({
        sql: "SELECT pid FROM daemon_state WHERE id = ?",
        args: [RUNNER_DAEMON_STATE_ID],
      });
      const row = existing.rows[0] as { pid?: unknown } | undefined;
      const currentPid = typeof row?.pid === "number" ? row.pid : row?.pid == null ? null : Number(row.pid);

      if (currentPid && currentPid !== pid && isProcessRunning(currentPid)) {
        throw new Error(`Another companyhelm daemon is already running with pid ${currentPid}.`);
      }

      await client.execute({
        sql:
          "INSERT INTO daemon_state (id, pid, log_path, started_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, log_path = excluded.log_path, started_at = excluded.started_at, updated_at = excluded.updated_at",
        args: [RUNNER_DAEMON_STATE_ID, pid, logPath, now, now],
      });
      await client.execute("COMMIT");
    } catch (error: unknown) {
      await client.execute("ROLLBACK");
      throw error;
    }
  } finally {
    client.close();
  }
}

export async function clearCurrentDaemonState(stateDbPath: string, pid: number): Promise<void> {
  const now = new Date().toISOString();
  const { db, client } = await initDb(stateDbPath);

  try {
    const existing = await db.select().from(daemonState).where(eq(daemonState.id, RUNNER_DAEMON_STATE_ID)).all();
    const current = existing[0];
    if (!current || current.pid !== pid) {
      return;
    }

    await db
      .update(daemonState)
      .set({
        pid: null,
        updatedAt: now,
      })
      .where(eq(daemonState.id, RUNNER_DAEMON_STATE_ID));
  } finally {
    client.close();
  }
}
