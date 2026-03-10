import assert from "node:assert/strict";
import { containsCtrlCInterruptInput, restoreInteractiveTerminalState } from "../../dist/utils/terminal.js";

test("containsCtrlCInterruptInput detects plain ETX and terminal keyboard protocol Ctrl-C sequences", () => {
  assert.equal(containsCtrlCInterruptInput("\u0003"), true);
  assert.equal(containsCtrlCInterruptInput("\u001b[99;5u"), true);
  assert.equal(containsCtrlCInterruptInput("\u001b[99;5:3u"), true);
  assert.equal(containsCtrlCInterruptInput("\u001b[27;5;99~"), true);
  assert.equal(containsCtrlCInterruptInput("plain text"), false);
});

test("restoreInteractiveTerminalState disables raw mode and restores keyboard/cursor state", () => {
  const writes: string[] = [];
  const stdin = {
    isTTY: true,
    setRawMode: (value: boolean) => {
      assert.equal(value, false);
    },
  };
  const stdout = {
    isTTY: true,
    write: (value: string) => {
      writes.push(value);
      return true;
    },
  };

  restoreInteractiveTerminalState(stdin, stdout);

  assert.deepEqual(writes, ["\u001b[<u", "\u001b[?25h"]);
});
