import { describe, expect, test } from "bun:test";
import type {
  Message,
  Part,
  Session,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import type { V2Client } from "../src/api";
import { compactSession } from "../src/compact/compact";
import type { MessageWithParts } from "../src/compact/plan";
import type {
  CompactProgressReporter,
  CompactProgressUpdate,
} from "../src/compact/progress";

describe("magic compact", () => {
  test("preserves the active prompt prefix and model", async () => {
    const requests = await runCompaction({
      ...session("source"),
      agent: "build",
      model: {
        providerID: "provider",
        id: "model",
        variant: "fast",
      },
      permission: [
        {
          permission: "read",
          pattern: "*",
          action: "allow",
        },
      ],
    });

    expect(requests.updates).toEqual([
      {
        sessionID: "ephemeral",
        title: "[TEMP] Test session",
        permission: [
          {
            permission: "read",
            pattern: "*",
            action: "allow",
          },
        ],
      },
    ]);
    expect(requests.prompts[0]).toMatchObject({
      sessionID: "ephemeral",
      agent: "build",
      model: {
        providerID: "provider",
        modelID: "model",
      },
      variant: "fast",
    });
  });

  test("omits unavailable prompt settings", async () => {
    const requests = await runCompaction(session("source"));

    expect(requests.updates).toEqual([
      {
        sessionID: "ephemeral",
        title: "[TEMP] Test session",
      },
    ]);
    expect(requests.prompts[0]).not.toHaveProperty("agent");
    expect(requests.prompts[0]).not.toHaveProperty("model");
    expect(requests.prompts[0]).not.toHaveProperty("variant");
  });

  test("derives missing session model settings from the latest assistant turn", async () => {
    const requests = requestLog();
    requests.modelLimit = { context: 100_000, output: 4_000 };
    const messages = compactableMessages();
    const assistant = messages[1]?.info;
    if (assistant?.role === "assistant") {
      assistant.agent = "build";
      assistant.providerID = "provider";
      assistant.modelID = "model";
      assistant.variant = "fast";
    }

    await runCompaction(session("source"), undefined, requests, messages);

    expect(requests.prompts[0]).toMatchObject({
      sessionID: "ephemeral",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      variant: "fast",
    });
  });

  test("repairs one malformed summary response in a fresh minimal session", async () => {
    const requests = await runCompaction(
      {
        ...session("source"),
        agent: "plan",
        model: {
          providerID: "qwen",
          id: "qwen-model",
          variant: "thinking",
        },
      },
      [
        "I summarized the request but forgot the XML wrapper.",
        "<summary><user>Request</user><assistant>Completed the request.</assistant></summary>",
      ],
    );

    expect(requests.prompts).toHaveLength(2);
    expect(requests.prompts[1]).toMatchObject({
      sessionID: "repair",
      agent: "plan",
      model: {
        providerID: "qwen",
        modelID: "qwen-model",
      },
      variant: "thinking",
    });
    expect(promptText(requests.prompts[1]!)).toContain(
      "Repair the Previous Summary Response",
    );
    expect(promptText(requests.prompts[1]!)).toContain(
      "I summarized the request but forgot the XML wrapper.",
    );
    expect(requests.deletes).toEqual(["repair", "ephemeral"]);
  });

  test("stops after one unsuccessful repair and deletes both temporary sessions", async () => {
    const requests = requestLog();

    await expect(
      runCompaction(session("source"), ["not xml", "still not xml"], requests),
    ).rejects.toThrow("Summary XML parsing failed after one repair attempt.");

    expect(requests.prompts).toHaveLength(2);
    expect(requests.deletes).toEqual(["repair", "ephemeral"]);
  });

  test("does not misclassify an empty provider response as malformed XML", async () => {
    const requests = requestLog();

    await expect(
      runCompaction(session("source"), [""], requests),
    ).rejects.toThrow("Summary model returned no text");

    expect(requests.prompts).toHaveLength(1);
    expect(requests.creates).toHaveLength(0);
    expect(requests.deletes).toEqual(["ephemeral"]);
  });

  test("surfaces a provider context error without attempting XML repair", async () => {
    const requests = requestLog();
    requests.providerError = {
      name: "ContextOverflowError",
      data: { message: "prompt plus output exceeds the context window" },
    };

    await expect(
      runCompaction(session("source"), undefined, requests),
    ).rejects.toThrow(
      "Summary provider failed with ContextOverflowError: prompt plus output exceeds the context window",
    );

    expect(requests.prompts).toHaveLength(1);
    expect(requests.creates).toHaveLength(0);
    expect(requests.deletes).toEqual(["ephemeral"]);
  });

  test("trims large tool output only in the temporary summary fork", async () => {
    const requests = requestLog();
    const messages = compactableMessages([
      toolPart("tool", "read", "x".repeat(2_000)),
    ]);

    await runCompaction(session("source"), undefined, requests, messages);

    const temporaryUpdate = requests.partUpdates.find(
      request => request["sessionID"] === "ephemeral",
    );
    const part = temporaryUpdate?.["part"] as ToolPart | undefined;
    expect(part?.state.status).toBe("completed");
    if (part?.state.status === "completed") {
      expect(part.state.output).toContain(
        "omitted from temporary summary context",
      );
    }
  });

  test("splits an oversized request into complete turn batches and carries prior summaries", async () => {
    const requests = requestLog();
    requests.modelLimit = { context: 4_000, output: 500 };
    const source = {
      ...session("source"),
      model: { providerID: "provider", id: "model" },
    };
    const messages = compactableTurnMessages(2, "word ".repeat(1_800));
    const responses = [
      "<summary><user>Request 1</user><assistant>Summary for turn one.</assistant></summary>",
      "<summary><user>Request 2</user><assistant>Summary for turn two.</assistant></summary>",
    ];

    await runCompaction(source, responses, requests, messages);

    expect(requests.prompts.map(request => request["sessionID"])).toEqual([
      "batch-1",
      "batch-2",
    ]);
    expect(promptText(requests.prompts[1]!)).toContain("Summary for turn one.");
    expect(requests.deletes).toEqual(["batch-1", "batch-2", "ephemeral"]);
    expect(requests.summaries).toEqual([
      "Summary for turn one.",
      "Summary for turn two.",
    ]);
  });

  test("reports completed turns as summary batches finish", async () => {
    const requests = requestLog();
    requests.modelLimit = { context: 4_000, output: 500 };
    const source = {
      ...session("source"),
      model: { providerID: "provider", id: "model" },
    };
    const messages = compactableTurnMessages(2, "word ".repeat(1_800));
    const progress: CompactProgressUpdate[] = [];

    await runCompaction(
      source,
      [
        "<summary><user>Request 1</user><assistant>Summary one.</assistant></summary>",
        "<summary><user>Request 2</user><assistant>Summary two.</assistant></summary>",
      ],
      requests,
      messages,
      update => {
        progress.push(update);
      },
    );

    expect(progress).toEqual([
      {
        phase: "preparing",
        completedTurns: 0,
        totalTurns: 2,
      },
      {
        phase: "summarizing",
        completedTurns: 0,
        totalTurns: 2,
        detail: "processing turns 1-1",
      },
      {
        phase: "summarizing",
        completedTurns: 1,
        totalTurns: 2,
      },
      {
        phase: "summarizing",
        completedTurns: 1,
        totalTurns: 2,
        detail: "processing turns 2-2",
      },
      {
        phase: "summarizing",
        completedTurns: 2,
        totalTurns: 2,
      },
      {
        phase: "applying",
        completedTurns: 2,
        totalTurns: 2,
      },
    ]);
  });

  test("does not fail compaction when progress reporting fails", async () => {
    const reporter: CompactProgressReporter = () => {
      throw new Error("TUI update unavailable");
    };

    await expect(
      runCompaction(
        session("source"),
        undefined,
        requestLog(),
        compactableMessages(),
        reporter,
      ),
    ).resolves.toBeDefined();
  });

  test("recursively splits a batch when the provider reports context overflow", async () => {
    const requests = requestLog();
    requests.modelLimit = { context: 4_000, output: 500 };
    const source = {
      ...session("source"),
      model: { providerID: "provider", id: "model" },
    };
    const messages = compactableTurnMessages(2, "short assistant result");
    const firstAssistant = messages[1]?.info;
    if (firstAssistant?.role === "assistant") {
      firstAssistant.tokens.input = 3_500;
    }

    await runCompaction(
      source,
      [
        {
          error: {
            name: "ContextOverflowError",
            data: { message: "batch exceeded provider context" },
          },
        },
        "<summary><user>Request 1</user><assistant>Recovered summary one.</assistant></summary>",
        "<summary><user>Request 2</user><assistant>Recovered summary two.</assistant></summary>",
      ],
      requests,
      messages,
    );

    expect(requests.prompts.map(request => request["sessionID"])).toEqual([
      "batch-1",
      "batch-2",
      "batch-3",
    ]);
    expect(promptText(requests.prompts[2]!)).toContain(
      "Recovered summary one.",
    );
    expect(requests.deletes).toEqual([
      "batch-1",
      "batch-2",
      "batch-3",
      "ephemeral",
    ]);
  });

  test("does not inject partial summaries when a later batch fails", async () => {
    const requests = requestLog();
    requests.modelLimit = { context: 4_000, output: 500 };
    const source = {
      ...session("source"),
      model: { providerID: "provider", id: "model" },
    };
    const messages = compactableTurnMessages(2, "word ".repeat(1_800));

    await expect(
      runCompaction(
        source,
        [
          "<summary><user>Request 1</user><assistant>Summary one.</assistant></summary>",
          "malformed second batch",
          "still malformed",
        ],
        requests,
        messages,
      ),
    ).rejects.toThrow("Summary XML parsing failed after one repair attempt");

    expect(requests.partUpdates).toHaveLength(0);
    expect(requests.deletes).toEqual([
      "batch-1",
      "batch-2",
      "repair",
      "ephemeral",
    ]);
  });

  test("fails early with an actionable error when the pruned request still cannot fit", async () => {
    const requests = requestLog();
    requests.modelLimit = { context: 100, output: 50 };
    const source = {
      ...session("source"),
      model: { providerID: "provider", id: "model" },
    };

    await expect(runCompaction(source, undefined, requests)).rejects.toThrow(
      "cannot fit assistant turn 1 into an isolated summary batch",
    );

    expect(requests.prompts).toHaveLength(0);
    expect(requests.deletes).toEqual(["ephemeral"]);
  });
});

type RequestLog = {
  prompts: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  creates: Record<string, unknown>[];
  deletes: string[];
  partUpdates: Record<string, unknown>[];
  modelLimit?: { context: number; output: number };
  providerError?: MockProviderError;
  summaries: string[];
};

type MockProviderError = {
  name: "ContextOverflowError";
  data: { message: string };
};

type MockResponse = string | { error: MockProviderError };

async function runCompaction(
  sourceSession: Session,
  responses: MockResponse[] = [
    "<summary><user>Request</user><assistant>Completed the request.</assistant></summary>",
  ],
  requests = requestLog(),
  messages = compactableMessages(),
  reportProgress?: CompactProgressReporter,
): Promise<RequestLog> {
  let responseIndex = 0;
  let batchIndex = 0;
  const v2 = {
    session: {
      messages: async () => ({ data: messages }),
      fork: async () => ({ data: session("ephemeral") }),
      create: async (request: Record<string, unknown>) => {
        requests.creates.push(request);
        const title = String(request["title"] ?? "");
        const id = title.startsWith("[TEMP SUMMARY BATCH")
          ? `batch-${++batchIndex}`
          : "repair";
        return { data: session(id) };
      },
      update: async (request: Record<string, unknown>) => {
        requests.updates.push(request);
        return { data: session("ephemeral") };
      },
      prompt: async (request: Record<string, unknown>) => {
        requests.prompts.push(request);
        const mockResponse =
          responses[responseIndex++] ?? responses.at(-1) ?? "";
        const text = typeof mockResponse === "string" ? mockResponse : "";
        const error =
          typeof mockResponse === "string"
            ? requests.providerError
            : mockResponse.error;
        return {
          data: {
            info: { error },
            parts: [textPart("response", "ephemeral", "response", text)],
          },
        };
      },
      delete: async ({ sessionID }: { sessionID: string }) => {
        requests.deletes.push(sessionID);
        return { data: true };
      },
    },
    part: {
      update: async (request: Record<string, unknown>) => {
        requests.partUpdates.push(request);
        return { data: request["part"] };
      },
    },
    provider: {
      list: async () => ({
        data: {
          all: requests.modelLimit
            ? [
                {
                  id: "provider",
                  models: {
                    model: { limit: requests.modelLimit },
                  },
                },
              ]
            : [],
          connected: [],
          default: {},
        },
      }),
    },
  } as unknown as V2Client;

  const result = await compactSession(
    v2,
    sourceSession,
    "source",
    0,
    reportProgress,
  );
  requests.summaries = result.summaries;
  return requests;
}

function requestLog(): RequestLog {
  return {
    prompts: [],
    updates: [],
    creates: [],
    deletes: [],
    partUpdates: [],
    summaries: [],
  };
}

function promptText(request: Record<string, unknown>): string {
  const parts = request["parts"] as { type: string; text: string }[];
  return parts[0]?.text ?? "";
}

function compactableMessages(assistantParts: Part[] = []): MessageWithParts[] {
  return [
    message("user", "user", [
      textPart("user-text", "source", "user", "Request"),
    ]),
    message("assistant", "assistant", assistantParts),
  ];
}

function compactableTurnMessages(
  count: number,
  assistantText: string,
): MessageWithParts[] {
  const messages: MessageWithParts[] = [];
  for (let index = 1; index <= count; index++) {
    const userID = `user-${index}`;
    const assistantID = `assistant-${index}`;
    messages.push(
      message(userID, "user", [
        textPart(`user-text-${index}`, "source", userID, `Request ${index}`),
      ]),
      message(assistantID, "assistant", [
        textPart(
          `assistant-text-${index}`,
          "source",
          assistantID,
          assistantText,
        ),
      ]),
    );
  }
  return messages;
}

function message(
  id: string,
  role: "user" | "assistant",
  parts: Part[],
): MessageWithParts {
  return {
    info: {
      id,
      role,
      ...(role === "assistant"
        ? {
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          }
        : {}),
    } as Message,
    parts,
  };
}

function toolPart(id: string, tool: string, output: string): ToolPart {
  return {
    id,
    sessionID: "source",
    messageID: "assistant",
    type: "tool",
    callID: "call",
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function session(id: string): Session {
  return { id, title: "Test session" } as Session;
}

function textPart(
  id: string,
  sessionID: string,
  messageID: string,
  text: string,
): TextPart {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
  };
}
