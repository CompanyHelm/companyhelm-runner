import { dirname, join } from "node:path";
import { expandHome } from "./path.js";

export const DAEMON_CHILD_ENV = "COMPANYHELM_DAEMON_CHILD";
export const DAEMON_LOG_PATH_ENV = "COMPANYHELM_DAEMON_LOG_PATH";

export function resolveDaemonLogPath(stateDbPath: string): string {
  return join(dirname(expandHome(stateDbPath)), "daemon.log");
}

export function resolveDaemonLogDirectory(stateDbPath: string): string {
  return dirname(resolveDaemonLogPath(stateDbPath));
}
