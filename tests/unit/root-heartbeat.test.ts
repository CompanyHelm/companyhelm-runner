import assert from "node:assert/strict";
import { runCommandLoop } from "../../dist/commands/root.js";

test("runCommandLoop responds to heartbeat requests with the matching request id", async () => {
  const sentMessages: unknown[] = [];
  const commandChannel = {
    async *[Symbol.asyncIterator]() {
      yield {
        requestId: "heartbeat-request-1",
        request: {
          case: "heartbeatRequest",
          value: {},
        },
      };
    },
  };
  const messageSink = {
    send: async (message: unknown) => {
      sentMessages.push(message);
    },
  };
  const logger = {
    warn: () => undefined,
  };

  await runCommandLoop(
    {} as never,
    commandChannel as never,
    messageSink as never,
    {} as never,
    undefined,
    logger as never,
  );

  assert.equal(sentMessages.length, 1);
  assert.equal(
    (sentMessages[0] as { requestId?: string }).requestId,
    "heartbeat-request-1",
  );
  assert.equal(
    (sentMessages[0] as { payload?: { case?: string } }).payload?.case,
    "heartbeatResponse",
  );
});
