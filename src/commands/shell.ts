import * as p from "@clack/prompts";
import type { Command } from "commander";
import { eq } from "drizzle-orm";
import { createInterface } from "node:readline";
import { config as configSchema } from "../config.js";
import { runThreadDockerCommand } from "./thread/docker.js";
import { RUNNER_DAEMON_STATE_ID } from "../state/daemon_state.js";
import { initDb } from "../state/db.js";
import { agentSdks, daemonState, llmModels, threadUserMessageRequestStore, threads } from "../state/schema.js";
import { addRunnerStartOptions } from "./runner/common.js";
import { restoreInteractiveTerminalState } from "../utils/terminal.js";
import { expandHome } from "../utils/path.js";

const NON_OVERRIDABLE_DAEMON_OPTION_NAMES = new Set(["daemon", "serverUrl", "secret", "help"]);
const SHELL_PROMPT = "companyhelm db> ";

export interface ShellDaemonOption {
  name: string;
  longFlag: string;
  description: string;
  takesValue: boolean;
  negate: boolean;
  defaultValue: unknown;
}

function resolveDaemonOptionValue(option: ShellDaemonOption, values: Record<string, unknown>): unknown {
  const explicit = values[option.name];
  if (explicit !== undefined) {
    return explicit;
  }

  if (option.defaultValue !== undefined) {
    return option.defaultValue;
  }

  if (!option.takesValue) {
    return option.negate ? true : false;
  }

  return undefined;
}

export function getShellConfigurableDaemonOptions(program: Command): ShellDaemonOption[] {
  const runnerStartCommand = addRunnerStartOptions(program.createCommand("start"));

  return runnerStartCommand.options
    .filter((option) => {
      if (!option.long || option.hidden) {
        return false;
      }

      return !NON_OVERRIDABLE_DAEMON_OPTION_NAMES.has(option.attributeName());
    })
    .map((option) => ({
      name: option.attributeName(),
      longFlag: option.long!,
      description: option.description || "",
      takesValue: option.required || option.optional,
      negate: option.negate,
      defaultValue: option.defaultValue,
    }));
}

export function buildShellDaemonOverrideArgs(
  options: ShellDaemonOption[],
  values: Record<string, unknown>,
): string[] {
  const args: string[] = [];

  for (const option of options) {
    const value = resolveDaemonOptionValue(option, values);
    if (option.takesValue) {
      if (value !== undefined && value !== null && String(value).trim().length > 0) {
        args.push(option.longFlag, String(value));
      }
      continue;
    }

    const enabled = Boolean(value);
    if (option.negate) {
      if (!enabled) {
        args.push(option.longFlag);
      }
      continue;
    }

    if (enabled) {
      args.push(option.longFlag);
    }
  }

  return args;
}

export interface ShellCommandOptions {
  stateDbPath?: string;
}

type ParsedShellCommand =
  | { type: "help" }
  | { type: "list-table"; tableKey: ShellTableKey }
  | { type: "thread-status"; threadId: string }
  | { type: "list-containers" }
  | { type: "thread-docker-shell"; threadId: string }
  | { type: "show-daemon" }
  | { type: "exit" }
  | { type: "unknown"; input: string };

type ShellDatabase = Awaited<ReturnType<typeof initDb>>["db"];
type ShellMainAction =
  | "list-table"
  | "thread-status"
  | "list-containers"
  | "thread-docker-shell"
  | "show-daemon"
  | "help"
  | "exit";

type ShellTableKey = "threads" | "agent-sdks" | "llm-models" | "thread-user-message-request-store" | "daemon-state";

interface ShellTableDefinition {
  key: ShellTableKey;
  label: string;
  menuLabel: string;
  menuHint: string;
  commandAliases: string[];
  loadRows: (db: ShellDatabase) => Promise<Array<Record<string, unknown>>>;
}

const SHELL_TABLES: ShellTableDefinition[] = [
  {
    key: "threads",
    label: "Threads",
    menuLabel: "List threads",
    menuHint: "Full rows from the threads table",
    commandAliases: ["threads", "thread"],
    loadRows: async (db) => (await db.select().from(threads).orderBy(threads.id).all()) as Array<Record<string, unknown>>,
  },
  {
    key: "agent-sdks",
    label: "Agent SDKs",
    menuLabel: "List SDKs",
    menuHint: "Full rows from the agent_sdks table",
    commandAliases: ["sdks", "sdk", "agent-sdks"],
    loadRows: async (db) => (await db.select().from(agentSdks).orderBy(agentSdks.name).all()) as Array<Record<string, unknown>>,
  },
  {
    key: "llm-models",
    label: "LLM models",
    menuLabel: "List models",
    menuHint: "Full rows from the llm_models table",
    commandAliases: ["models", "model", "llm-models"],
    loadRows: async (db) => (
      await db.select().from(llmModels).orderBy(llmModels.sdkName, llmModels.name).all()
    ) as Array<Record<string, unknown>>,
  },
  {
    key: "thread-user-message-request-store",
    label: "Thread user message request store",
    menuLabel: "List requests",
    menuHint: "Full rows from the thread_user_message_request_store table",
    commandAliases: ["requests", "request", "message-requests", "user-message-requests"],
    loadRows: async (db) => (
      await db.select().from(threadUserMessageRequestStore).orderBy(threadUserMessageRequestStore.id).all()
    ) as Array<Record<string, unknown>>,
  },
  {
    key: "daemon-state",
    label: "Daemon state table",
    menuLabel: "List daemon rows",
    menuHint: "Full rows from the daemon_state table",
    commandAliases: ["daemon", "daemons", "daemon-state"],
    loadRows: async (db) => (
      await db.select().from(daemonState).orderBy(daemonState.id).all()
    ) as Array<Record<string, unknown>>,
  },
];

const SHELL_TABLE_BY_KEY = new Map(SHELL_TABLES.map((table) => [table.key, table] as const));
const SHELL_TABLE_BY_ALIAS = new Map(
  SHELL_TABLES.flatMap((table) => table.commandAliases.map((alias) => [alias, table] as const)),
);

const SHELL_HELP_TEXT = [
  "Available commands:",
  "  help                 Show this help.",
  "  list threads         List full thread rows from the threads table.",
  "  list sdks            List full rows from the agent_sdks table.",
  "  list models          List full rows from the llm_models table.",
  "  list requests        List full rows from the thread_user_message_request_store table.",
  "  list daemon          List full rows from the daemon_state table.",
  "  thread status <id>   Show the full thread row for one thread.",
  "  list containers      List thread container fields from the state DB.",
  "  thread docker <id>   Docker exec bash into the selected thread runtime container.",
  "  show daemon          Show the daemon_state row from the state DB.",
  "  exit                 Exit the shell.",
].join("\n");

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function printRows(label: string, rows: Array<Record<string, unknown>>): void {
  console.log();
  console.log(`${label}:`);
  if (rows.length === 0) {
    console.log("  - none");
    console.log();
    return;
  }

  for (const row of rows) {
    console.log(JSON.stringify(row, jsonReplacer, 2));
  }
  console.log();
}

function printRow(label: string, row: Record<string, unknown>): void {
  console.log();
  console.log(`${label}:`);
  console.log(JSON.stringify(row, jsonReplacer, 2));
  console.log();
}

function resolveShellTableByAlias(alias: string): ShellTableDefinition | undefined {
  return SHELL_TABLE_BY_ALIAS.get(alias.toLowerCase());
}

export function parseShellCommand(input: string): ParsedShellCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    return { type: "help" };
  }

  const tokens = trimmed.split(/\s+/);
  const normalized = tokens.map((token) => token.toLowerCase());

  if (normalized.length === 1) {
    switch (normalized[0]) {
      case "help":
      case "?":
        return { type: "help" };
      case "threads":
        return { type: "list-table", tableKey: "threads" };
      case "sdks":
      case "sdk":
        return { type: "list-table", tableKey: "agent-sdks" };
      case "models":
      case "model":
        return { type: "list-table", tableKey: "llm-models" };
      case "requests":
      case "request":
        return { type: "list-table", tableKey: "thread-user-message-request-store" };
      case "containers":
        return { type: "list-containers" };
      case "daemon":
        return { type: "show-daemon" };
      case "exit":
      case "quit":
        return { type: "exit" };
      default:
        return { type: "unknown", input: trimmed };
    }
  }

  if (normalized.length === 2) {
    if (normalized[0] === "list" && normalized[1] === "containers") {
      return { type: "list-containers" };
    }

    if (normalized[0] === "list") {
      const table = resolveShellTableByAlias(normalized[1]);
      if (table) {
        return { type: "list-table", tableKey: table.key };
      }
    }

    if (normalized[0] === "show" && normalized[1] === "daemon") {
      return { type: "show-daemon" };
    }

    if (normalized[0] === "status") {
      return { type: "thread-status", threadId: tokens[1] };
    }
  }

  if (normalized.length >= 3 && normalized[0] === "thread" && normalized[1] === "status") {
    return { type: "thread-status", threadId: tokens.slice(2).join(" ") };
  }

  if (normalized.length >= 3 && normalized[0] === "thread" && normalized[1] === "docker") {
    return { type: "thread-docker-shell", threadId: tokens.slice(2).join(" ") };
  }

  if (normalized.length >= 3 && normalized[0] === "docker" && normalized[1] === "shell") {
    return { type: "thread-docker-shell", threadId: tokens.slice(2).join(" ") };
  }

  return { type: "unknown", input: trimmed };
}

async function selectThreadId(
  db: ShellDatabase,
  message: string,
): Promise<string | null> {
  const rows = await db
    .select({
      id: threads.id,
      status: threads.status,
      model: threads.model,
    })
    .from(threads)
    .orderBy(threads.id)
    .all();

  if (rows.length === 0) {
    p.log.warn("No threads found.");
    return null;
  }

  const selection = await p.select<string>({
    message,
    options: rows.map((row) => ({
      value: row.id,
      label: row.id,
      hint: `status=${row.status} model=${row.model}`,
    })),
  });

  return p.isCancel(selection) ? null : selection;
}

async function promptShellAction(): Promise<ShellMainAction | null> {
  const action = await p.select<ShellMainAction>({
    message: "Choose shell action",
    options: [
      { value: "list-table", label: "Inspect runner tables", hint: "Threads, SDKs, models, requests, daemon state" },
      { value: "thread-status", label: "Thread status" },
      { value: "list-containers", label: "List containers" },
      { value: "thread-docker-shell", label: "Thread docker shell (bash)" },
      { value: "show-daemon", label: "Show daemon state" },
      { value: "help", label: "Show help" },
      { value: "exit", label: "Exit shell" },
    ],
  });

  return p.isCancel(action) ? null : action;
}

async function promptShellTable(): Promise<ShellTableKey | null> {
  const selection = await p.select<ShellTableKey>({
    message: "Choose table to list",
    options: SHELL_TABLES.map((table) => ({
      value: table.key,
      label: table.menuLabel,
      hint: table.menuHint,
    })),
  });

  return p.isCancel(selection) ? null : selection;
}

async function runClackShell(db: ShellDatabase, stateDbPath: string): Promise<void> {
  p.intro(`CompanyHelm DB shell\n${expandHome(stateDbPath)}`);

  try {
    while (true) {
      const action = await promptShellAction();
      if (!action || action === "exit") {
        p.outro("Shell closed.");
        return;
      }

      try {
        switch (action) {
          case "help":
            console.log(SHELL_HELP_TEXT);
            break;
          case "list-table": {
            const tableKey = await promptShellTable();
            if (!tableKey) {
              break;
            }

            await runParsedShellCommand(db, { type: "list-table", tableKey });
            break;
          }
          case "thread-status": {
            const threadId = await selectThreadId(db, "Select thread");
            if (!threadId) {
              break;
            }

            await runParsedShellCommand(db, { type: "thread-status", threadId });
            break;
          }
          case "list-containers":
            await runParsedShellCommand(db, { type: "list-containers" });
            break;
          case "thread-docker-shell": {
            const threadId = await selectThreadId(db, "Select thread for docker bash");
            if (!threadId) {
              break;
            }

            restoreInteractiveTerminalState();
            await runThreadDockerCommand({ threadId });
            break;
          }
          case "show-daemon":
            await runParsedShellCommand(db, { type: "show-daemon" });
            break;
          default:
            break;
        }
      } catch (error: unknown) {
        p.log.error(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    restoreInteractiveTerminalState();
  }
}

async function runParsedShellCommand(db: ShellDatabase, command: ParsedShellCommand): Promise<boolean> {
  switch (command.type) {
    case "help":
      console.log(SHELL_HELP_TEXT);
      return false;
    case "list-table": {
      const table = SHELL_TABLE_BY_KEY.get(command.tableKey);
      if (!table) {
        console.log(`Unknown table key: ${command.tableKey}`);
        return false;
      }

      const rows = await table.loadRows(db);
      printRows(table.label, rows);
      return false;
    }
    case "thread-status": {
      const row = await db.select().from(threads).where(eq(threads.id, command.threadId)).get();
      if (!row) {
        console.log(`Thread '${command.threadId}' was not found.`);
        return false;
      }

      printRow(`Thread '${command.threadId}'`, row as Record<string, unknown>);
      return false;
    }
    case "list-containers": {
      const rows = await db
        .select({
          threadId: threads.id,
          status: threads.status,
          isCurrentTurnRunning: threads.isCurrentTurnRunning,
          runtimeContainer: threads.runtimeContainer,
          dindContainer: threads.dindContainer,
          workspace: threads.workspace,
        })
        .from(threads)
        .orderBy(threads.id)
        .all();
      printRows("Containers", rows as Array<Record<string, unknown>>);
      return false;
    }
    case "thread-docker-shell":
      restoreInteractiveTerminalState();
      await runThreadDockerCommand({ threadId: command.threadId });
      return false;
    case "show-daemon": {
      const row = await db.select().from(daemonState).where(eq(daemonState.id, RUNNER_DAEMON_STATE_ID)).get();
      if (!row) {
        console.log("Daemon state: none");
        return false;
      }

      printRow("Daemon state", row as Record<string, unknown>);
      return false;
    }
    case "exit":
      return true;
    case "unknown":
      console.log(`Unknown command: ${command.input}`);
      console.log("Use 'help' to see available commands.");
      return false;
    default:
      return false;
  }
}

export async function runShellCommand(options: ShellCommandOptions = {}): Promise<void> {
  const cfg = configSchema.parse({
    state_db_path: options.stateDbPath,
  });
  const { db, client } = await initDb(cfg.state_db_path);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  try {
    if (interactive) {
      await runClackShell(db, cfg.state_db_path);
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
      historySize: 0,
    });

    console.log(`State DB: ${expandHome(cfg.state_db_path)}`);
    console.log(SHELL_HELP_TEXT);

    for await (const line of rl) {
      const shouldExit = await runParsedShellCommand(db, parseShellCommand(line));
      if (shouldExit) {
        break;
      }
    }
  } finally {
    client.close();
  }
}

export function registerShellCommand(program: Command): void {
  program
    .command("shell")
    .description("Open an interactive shell for inspecting local state and entering thread runtime containers.")
    .option("--state-db-path <path>", "State database path override (defaults to state.db under the active config directory).")
    .action(async (options: ShellCommandOptions) => {
      await runShellCommand(options);
    });
}
