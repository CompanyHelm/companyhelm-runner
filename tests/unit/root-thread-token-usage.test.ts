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

  it("reads legacy snake_case token usage payloads", () => {
    const notification = {
      method: "thread/tokenUsage/updated",
      params: {
        thread_id: "sdk-thread-legacy",
        turn_id: "sdk-turn-legacy",
        token_usage: {
          total_token_usage: {
            total_tokens: 1200,
            input_tokens: 700,
            cached_input_tokens: 100,
            output_tokens: 350,
            reasoning_output_tokens: 50,
          },
          last_token_usage: {
            total_tokens: 300,
            input_tokens: 180,
            cached_input_tokens: 20,
            output_tokens: 90,
            reasoning_output_tokens: 10,
          },
          model_context_window: 200000,
        },
      },
    } as const;

    expect(extractThreadTokenUsageUpdateFromNotification(notification)).toEqual({
      sdkThreadId: "sdk-thread-legacy",
      sdkTurnId: "sdk-turn-legacy",
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
