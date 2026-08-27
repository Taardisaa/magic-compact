import { describe, expect, test } from "bun:test";
import type { Message, Session, TextPart } from "@opencode-ai/sdk/v2";
import type { V2Client } from "../src/api";
import { AutoCompactController } from "../src/auto-compact";
import type { MessageWithParts } from "../src/compact/plan";

describe("automatic magic compact takeover", () => {
  test("stays disabled unless native auto-compaction is explicitly handed off", async () => {
    const runtime = mockRuntime(true);
    const controller = new AutoCompactController({
      bufferTokens: 20,
      compact: runtime.compact,
    });

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.sessionGets).toBe(0);
    expect(runtime.compactCalls).toBe(0);
  });

  test("compacts before a pending message when the local estimate reaches the safe threshold", async () => {
    const runtime = mockRuntime(true);
    const controller = new AutoCompactController({
      bufferTokens: 20,
      compact: runtime.compact,
    });
    controller.setEnabled(true);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(1);
    expect(runtime.toasts[0]?.message).toContain(
      "Automatic Magic Compact triggered",
    );
  });

  test("does not compact while the locally counted context is below threshold", async () => {
    const runtime = mockRuntime(false);
    const controller = new AutoCompactController({
      bufferTokens: 20,
      compact: runtime.compact,
    });
    controller.setEnabled(true);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(0);
  });

  test("ignores Magic Compact internal no-reply messages", async () => {
    const runtime = mockRuntime(true);
    const controller = new AutoCompactController({
      bufferTokens: 20,
      compact: runtime.compact,
    });
    controller.setEnabled(true);

    await controller.beforeMessage(runtime.v2, {
      ...request(),
      parts: [
        textPart("internal", {
          magicCompact: { progress: true },
        }),
      ],
    });

    expect(runtime.sessionGets).toBe(0);
    expect(runtime.compactCalls).toBe(0);
  });

  test("ignores temporary summarization sessions", async () => {
    const runtime = mockRuntime(true, "[TEMP SUMMARY BATCH 1] Test");
    const controller = new AutoCompactController({
      bufferTokens: 20,
      compact: runtime.compact,
    });
    controller.setEnabled(true);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(0);
  });

  test("blocks the provider request when compaction cannot free enough context", async () => {
    const runtime = mockRuntime(true);
    runtime.keepLargeAfterCompaction = true;
    const controller = new AutoCompactController({
      bufferTokens: 20,
      compact: runtime.compact,
    });
    controller.setEnabled(true);

    await expect(
      controller.beforeMessage(runtime.v2, request()),
    ).rejects.toThrow("pending request was stopped");

    expect(runtime.compactCalls).toBe(1);
    expect(runtime.toasts.at(-1)?.variant).toBe("error");
  });

  test("blocks the provider request when no completed turn can be compacted", async () => {
    const runtime = mockRuntime(true);
    runtime.compactResult = false;
    const controller = new AutoCompactController({
      bufferTokens: 20,
      compact: runtime.compact,
    });
    controller.setEnabled(true);

    await expect(
      controller.beforeMessage(runtime.v2, request()),
    ).rejects.toThrow("No completed assistant turns");
  });
});

function request() {
  return {
    sessionID: "source",
    model: { providerID: "provider", modelID: "model" },
    parts: [textPart("pending")],
  };
}

function mockRuntime(startsLarge: boolean, title = "Test session") {
  const state = {
    compactCalls: 0,
    compactResult: true,
    compacted: false,
    keepLargeAfterCompaction: false,
    sessionGets: 0,
    toasts: [] as { message: string; variant: string }[],
  };

  const compact = async () => {
    state.compactCalls += 1;
    state.compacted = true;
    return state.compactResult;
  };

  const v2 = {
    session: {
      get: async () => {
        state.sessionGets += 1;
        return { data: { id: "source", title } as Session };
      },
      messages: async () => {
        const large =
          startsLarge && (!state.compacted || state.keepLargeAfterCompaction);
        return {
          data: [
            {
              info: { id: "user", role: "user" } as Message,
              parts: [textPart(large ? "word ".repeat(120) : "short")],
            },
          ] as MessageWithParts[],
        };
      },
    },
    provider: {
      list: async () => ({
        data: {
          all: [
            {
              id: "provider",
              models: {
                model: { limit: { context: 100, output: 20 } },
              },
            },
          ],
          connected: [],
          default: {},
        },
      }),
    },
    tui: {
      showToast: async (input: { message: string; variant: string }) => {
        state.toasts.push(input);
        return { data: true };
      },
    },
  } as unknown as V2Client;

  return Object.assign(state, { compact, v2 });
}

function textPart(text: string, metadata?: Record<string, unknown>): TextPart {
  return {
    id: `part-${text.length}`,
    sessionID: "source",
    messageID: "user",
    type: "text",
    text,
    metadata,
  } as TextPart;
}
