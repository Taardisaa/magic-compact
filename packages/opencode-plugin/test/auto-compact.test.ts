import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  Message,
  Session,
  TextPart,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import type { V2Client } from "../src/api";
import { AutoCompactController } from "../src/auto-compact";
import type { MessageWithParts } from "../src/compact/plan";

describe("automatic magic compact takeover", () => {
  test("stays disabled unless native auto-compaction is explicitly handed off", async () => {
    const runtime = mockRuntime([assistantUsage(85)]);
    const controller = createController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.sessionGets).toBe(0);
    expect(runtime.compactCalls).toBe(0);
  });

  test("compacts from provider-reported usage at the safe threshold", async () => {
    const runtime = mockRuntime([assistantUsage(85)]);
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(1);
    expect(runtime.messageGets).toBe(1);
    expect(runtime.toasts[0]?.message).toContain(
      "85 / 100 provider-reported tokens",
    );
  });

  test("does not compact below threshold even when transcript and pending text are large", async () => {
    const runtime = mockRuntime([
      userMessage("word ".repeat(1_000), 1),
      assistantUsage(79, 2),
    ]);
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, {
      ...request(),
      parts: [textPart("pending ".repeat(1_000))],
    });

    expect(runtime.compactCalls).toBe(0);
  });

  test("compacts after a structured provider context-overflow error", async () => {
    const runtime = mockRuntime([assistantOverflow()]);
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(1);
    expect(runtime.toasts[0]?.message).toContain(
      "provider reported a context overflow",
    );
  });

  test("does not guess when the latest assistant has no authoritative usage", async () => {
    const runtime = mockRuntime([assistantWithoutUsage()]);
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(0);
  });

  test("skips completed zero-usage proxy failures and uses the latest positive provider usage", async () => {
    const runtime = mockRuntime([
      assistantUsage(85, 1),
      assistantWithoutUsage(2),
      assistantWithoutUsage(3),
    ]);
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(1);
  });

  test("ignores an unfinished zero-usage row and uses the latest completed provider usage", async () => {
    const unfinished = assistantWithoutUsage(2);
    if (unfinished.info.role === "assistant") {
      delete unfinished.info.time.completed;
    }
    const runtime = mockRuntime([assistantUsage(85, 1), unfinished]);
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(1);
  });

  test("does not reuse provider usage invalidated by compaction", async () => {
    const runtime = mockRuntime([assistantUsage(95, 1), mutationNotice(2)]);
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(0);
  });

  test("uses fresh provider usage recorded after compaction", async () => {
    const runtime = mockRuntime([
      assistantUsage(95, 1),
      mutationNotice(2),
      assistantUsage(85, 3),
    ]);
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(1);
  });

  test("stops an internal provider continuation and compacts after session idle", async () => {
    const runtime = mockRuntime([assistantUsage(85)]);
    const controller = createEnabledController(runtime);

    await expect(
      controller.beforeProviderCall(runtime.v2, providerCall()),
    ).rejects.toThrow("preflight stopped this model call");
    expect(runtime.compactCalls).toBe(0);

    await controller.handleEvent(runtime.v2, {
      type: "session.idle",
      properties: { sessionID: "source" },
    });

    expect(runtime.compactCalls).toBe(1);
  });

  test("queues structured context overflow for compaction on idle", async () => {
    const runtime = mockRuntime([assistantWithoutUsage()]);
    const controller = createEnabledController(runtime);

    await controller.handleEvent(runtime.v2, {
      type: "session.error",
      properties: {
        sessionID: "source",
        error: { name: "ContextOverflowError" },
      },
    });
    await controller.handleEvent(runtime.v2, {
      type: "session.idle",
      properties: { sessionID: "source" },
    });

    expect(runtime.compactCalls).toBe(1);
  });

  test("does not classify unstructured proxy text as context overflow", async () => {
    const runtime = mockRuntime([assistantWithoutUsage()]);
    const controller = createEnabledController(runtime);

    await controller.handleEvent(runtime.v2, {
      type: "session.error",
      properties: {
        sessionID: "source",
        error: {
          name: "APIError",
          data: { message: "proxy upstream error: maximum context length" },
        },
      },
    });
    await controller.handleEvent(runtime.v2, {
      type: "session.idle",
      properties: { sessionID: "source" },
    });

    expect(runtime.compactCalls).toBe(0);
  });

  test("ignores Magic Compact internal no-reply messages", async () => {
    const runtime = mockRuntime([assistantUsage(85)]);
    const controller = createEnabledController(runtime);

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
    const runtime = mockRuntime(
      [assistantUsage(85)],
      "[TEMP SUMMARY BATCH 1] Test",
    );
    const controller = createEnabledController(runtime);

    await controller.beforeMessage(runtime.v2, request());

    expect(runtime.compactCalls).toBe(0);
  });

  test("blocks the provider request when no completed turn can be compacted", async () => {
    const runtime = mockRuntime([assistantUsage(85)]);
    runtime.compactResult = false;
    const controller = createEnabledController(runtime);

    await expect(
      controller.beforeMessage(runtime.v2, request()),
    ).rejects.toThrow("No completed assistant turns");
  });
});

function createController(runtime: ReturnType<typeof mockRuntime>) {
  return new AutoCompactController({
    compact: runtime.compact,
  });
}

function createEnabledController(runtime: ReturnType<typeof mockRuntime>) {
  const controller = createController(runtime);
  controller.setEnabled(true);
  return controller;
}

function request() {
  return {
    sessionID: "source",
    model: { providerID: "provider", modelID: "model" },
    parts: [textPart("pending")],
  };
}

function providerCall() {
  return {
    sessionID: "source",
    model: { limit: { context: 100, output: 20 } },
  };
}

function mockRuntime(messages: MessageWithParts[], title = "Test session") {
  const state = {
    compactCalls: 0,
    compactResult: true,
    messageGets: 0,
    sessionGets: 0,
    toasts: [] as { message: string; variant: string }[],
  };

  const compact = async () => {
    state.compactCalls += 1;
    return state.compactResult;
  };

  const v2 = {
    session: {
      get: async () => {
        state.sessionGets += 1;
        return {
          data: {
            id: "source",
            title,
            metadata: {},
          } as Session,
        };
      },
      messages: async () => {
        state.messageGets += 1;
        return { data: messages };
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

function assistantUsage(tokens: number, created = 1): MessageWithParts {
  return {
    info: {
      id: `assistant-${created}`,
      sessionID: "source",
      role: "assistant",
      time: { created, completed: created },
      parentID: "user",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "C:/workspace", root: "C:/workspace" },
      cost: 0,
      tokens: {
        input: tokens,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    } as AssistantMessage,
    parts: [],
  };
}

function assistantOverflow(created = 1): MessageWithParts {
  const message = assistantUsage(0, created);
  if (message.info.role === "assistant") {
    message.info.error = {
      name: "ContextOverflowError",
      data: { message: "Provider rejected the request as too large." },
    };
  }
  return message;
}

function assistantWithoutUsage(created = 1): MessageWithParts {
  return assistantUsage(0, created);
}

function userMessage(text: string, created: number): MessageWithParts {
  return {
    info: {
      id: `user-${created}`,
      sessionID: "source",
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    } as UserMessage,
    parts: [textPart(text)],
  };
}

function mutationNotice(created: number): MessageWithParts {
  return {
    info: {
      id: `mutation-${created}`,
      sessionID: "source",
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    } as Message,
    parts: [
      textPart("Magic Compaction #1\nCompaction Stats", {
        magicCompact: {
          stats: true,
          invalidatesProviderUsage: true,
        },
      }),
    ],
  };
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
