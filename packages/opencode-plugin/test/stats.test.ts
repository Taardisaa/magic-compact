import { describe, expect, test } from "bun:test";
import type { V2Client } from "../src/api";
import type { MessageWithParts } from "../src/compact/plan";
import { statsMessage } from "../src/stats/constants";
import { getProviderTokens } from "../src/stats/tokenize";
import type { ConversationStats } from "../src/storage/stats";

describe("magic compact stats", () => {
  test("treats zero provider usage as unavailable", async () => {
    const v2 = clientWithMessages([
      assistantMessage({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    ]);

    expect(await getProviderTokens(v2, "session")).toBeNull();
  });

  test("uses positive provider usage", async () => {
    const v2 = clientWithMessages([
      assistantMessage({
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 30, write: 10 },
      }),
    ]);

    expect(await getProviderTokens(v2, "session")).toBe(165);
  });

  test("skips a zeroed failed response and uses the latest positive usage", async () => {
    const v2 = clientWithMessages([
      assistantMessage({
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 30, write: 10 },
      }),
      assistantMessage({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    ]);

    expect(await getProviderTokens(v2, "session")).toBe(165);
  });

  test("describes missing custom-model pricing without rejecting the model", () => {
    const message = statsMessage(
      1,
      229_442,
      39_100,
      emptyStats(),
      "qwen38-27b",
    );

    expect(message).toContain("229.4K → 39.1K tokens (83% reduced)");
    expect(message).toContain("~190.3K tokens pruned");
    expect(message).toContain("Pricing unavailable for model: qwen38-27b");
    expect(message).not.toContain("Model not supported");
  });
});

function clientWithMessages(messages: MessageWithParts[]): V2Client {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  } as unknown as V2Client;
}

function assistantMessage(tokens: {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}): MessageWithParts {
  return {
    info: {
      id: "assistant",
      role: "assistant",
      tokens,
    },
    parts: [],
  } as MessageWithParts;
}

function emptyStats(): ConversationStats {
  return {
    version: 1,
    sourceSessionId: null,
    rootSessionId: "session",
    totalTokensPruned: 0,
    cachedTokensSaved: 0,
    processedAssistantMessageIds: [],
  };
}
