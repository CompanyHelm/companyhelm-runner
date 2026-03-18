import { describe, expect, it } from "vitest";
import { extractThreadTokenUsageUpdateFromNotification } from "../../dist/commands/root.js";

describe("extractThreadTokenUsageUpdateFromNotification", () => {
  it("reads mapped thread/tokenUsage/updated notifications", () => {
    const notification = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "sdk-thread-1",
        turnId: "sdk-turn-1",
        tokenUsage: {
          total: {
            totalTokens: 1200,
            inputTokens: 700,
            cachedInputTokens: 100,
            outputTokens: 350,
            reasoningOutputTokens: 50,
          },
          last: {
            totalTokens: 300,
            inputTokens: 180,
            cachedInputTokens: 20,
            outputTokens: 90,
            reasoningOutputTokens: 10,
          },
          modelContextWindow: 200000,
        },
      },
    } as const;

    expect(extractThreadTokenUsageUpdateFromNotification(notification)).toEqual({
      sdkThreadId: "sdk-thread-1",
      sdkTurnId: "sdk-turn-1",
      totalUsage: {
        totalTokens: 1200,
        inputTokens: 700,
        cachedInputTokens: 100,
        outputTokens: 350,
        reasoningOutputTokens: 50,
      },
      lastUsage: {
        totalTokens: 300,
        inputTokens: 180,
        cachedInputTokens: 20,
        outputTokens: 90,
        reasoningOutputTokens: 10,
      },
      modelContextWindow: 200000,
    });
  });

  it("ignores unrelated notifications", () => {
    expect(
      extractThreadTokenUsageUpdateFromNotification({
        method: "turn/completed",
        params: {
          threadId: "sdk-thread-1",
          turnId: "sdk-turn-1",
        },
      } as never),
    ).toBeNull();
  });
});
