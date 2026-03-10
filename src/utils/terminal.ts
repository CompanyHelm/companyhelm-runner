const CTRL_C_ETX = "\u0003";
const CTRL_C_CSI_U_PATTERN = /\u001b\[99;5(?::\d+)?u/;
const CTRL_C_MODIFY_OTHER_KEYS_PATTERN = /\u001b\[27;5;99~/;
const RESTORE_KEYBOARD_PROTOCOL_SEQUENCE = "\u001b[<u";
const SHOW_CURSOR_SEQUENCE = "\u001b[?25h";

export function containsCtrlCInterruptInput(input: string): boolean {
  return input.includes(CTRL_C_ETX) ||
    CTRL_C_CSI_U_PATTERN.test(input) ||
    CTRL_C_MODIFY_OTHER_KEYS_PATTERN.test(input);
}

export function restoreInteractiveTerminalState(
  stdin: Pick<NodeJS.ReadStream, "isTTY" | "setRawMode"> = process.stdin,
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout,
): void {
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
  } catch {
    // Best-effort prompt cleanup.
  }

  try {
    if (stdout.isTTY) {
      // Restore normal keyboard reporting if a prompt enabled kitty/xterm CSI-u handling.
      stdout.write(RESTORE_KEYBOARD_PROTOCOL_SEQUENCE);
      stdout.write(SHOW_CURSOR_SEQUENCE);
    }
  } catch {
    // Best-effort prompt cleanup.
  }
}
