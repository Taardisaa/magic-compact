import { describe, expect, test } from "bun:test";
import type { Message, Part, Session, TextPart } from "@opencode-ai/sdk/v2";
import type { V2Client } from "../src/api";
import {
  applyNativeCompactionPrompt,
  buildNativeSummary,
  commitNativeCompaction,
  countNativeVisibleTokens,
  needsNativeCompactionMigration,
  stripNativeCompactionTranscript,
} from "../src/compact/native";
import {
  createCompactionPlan,
  type MessageWithParts,
} from "../src/compact/plan";
import { countPartsTokens } from "../src/stats/tokenize";
import { AutoCompactController } from "../src/auto-compact";

describe("native OpenCode compaction writeback", () => {
  test("commits one real native summary block and replaces model output exactly", async () => {
    const messages = ordinaryTurn();
    const updates: Part[] = [];
    const deletes: string[] = [];
    const summarizeRequests: Record<string, unknown>[] = [];
    const autoCompact = new AutoCompactController();
    autoCompact.setEnabled(true);
    const v2 = {
      session: {
        messages: async () => ({ data: messages }),
        summarize: async (request: Record<string, unknown>) => {
          summarizeRequests.push(request);
          await autoCompact.beforeProviderCall({} as V2Client, {
            sessionID: "session",
            model: { limit: { context: 100, output: 20 } },
          });
          const compacting = { context: ["default"], prompt: undefined };
          applyNativeCompactionPrompt({ sessionID: "session" }, compacting);
          expect(compacting.context).toEqual([]);
          expect(compacting.prompt).toContain("READY");

          const transformed = { messages: [...messages] };
          stripNativeCompactionTranscript(transformed);
          expect(transformed.messages).toEqual([]);

          messages.push(
            message("compact-user", "user", [compactionPart("compact-user")]),
            nativeSummaryMessage("native-summary", "compact-user", [
              textPart("provider-text", "native-summary", "READY"),
              reasoningPart("provider-reasoning", "native-summary"),
            ]),
          );
          return { data: true };
        },
      },
      part: {
        update: async (request: { part: Part }) => {
          updates.push(request.part);
          return { data: request.part };
        },
        delete: async (request: { partID: string }) => {
          deletes.push(request.partID);
          return { data: true };
        },
      },
    } as unknown as V2Client;

    const result = await commitNativeCompaction(
      v2,
      sourceSession(),
      "session",
      "Exact prepared checkpoint.",
    );

    expect(summarizeRequests).toEqual([
      {
        sessionID: "session",
        providerID: "provider",
        modelID: "model",
        auto: false,
      },
    ]);
    expect(result.info).toMatchObject({
      role: "assistant",
      summary: true,
      parentID: "compact-user",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: "provider-text",
      type: "text",
      text: "Exact prepared checkpoint.",
      metadata: { magicCompact: { nativeSummary: true } },
    });
    expect(deletes).toEqual(["provider-reasoning"]);
  });

  test("carries the previous native checkpoint into the next prepared summary", async () => {
    const messages = [
      message("compact-user", "user", [compactionPart("compact-user")]),
      nativeSummaryMessage("native-summary", "compact-user", [
        textPart("old-summary", "native-summary", "Old durable context."),
      ]),
    ];
    const v2 = {
      session: { messages: async () => ({ data: messages }) },
    } as unknown as V2Client;

    const prepared = await buildNativeSummary(v2, sourceSession(), "session", [
      "New compacted work.",
    ]);

    expect(prepared).toContain("Old durable context.");
    expect(prepared).toContain("New compacted work.");
  });

  test("starts future Magic Compact plans after the native marker turn", async () => {
    const messages = [
      ...ordinaryTurn("old"),
      message("compact-user", "user", [compactionPart("compact-user")]),
      nativeSummaryMessage("native-summary", "compact-user", [
        textPart("summary", "native-summary", "Old context"),
      ]),
      ...ordinaryTurn("new"),
    ];
    const v2 = {
      session: { messages: async () => ({ data: messages }) },
    } as unknown as V2Client;

    const plan = await createCompactionPlan(v2, "session", 0);

    expect(
      plan.summarizedTurns.flatMap(turn =>
        turn.assistants.map(assistant => assistant.info.id),
      ),
    ).toEqual(["new-assistant"]);
  });

  test("detects legacy loose summaries that need one-time native migration", async () => {
    const legacy = message("legacy-assistant", "assistant", [
      {
        ...textPart("legacy-summary", "legacy-assistant", "Legacy summary"),
        metadata: { magicCompact: { summary: true } },
      },
    ]);
    const messages = [message("legacy-user", "user", []), legacy];
    const v2 = {
      session: { messages: async () => ({ data: messages }) },
    } as unknown as V2Client;

    expect(await needsNativeCompactionMigration(v2, "session")).toBe(true);

    messages.push(
      message("compact-user", "user", [compactionPart("compact-user")]),
      nativeSummaryMessage("native-summary", "compact-user", [
        textPart("native-text", "native-summary", "Native summary"),
      ]),
    );
    expect(await needsNativeCompactionMigration(v2, "session")).toBe(false);
  });

  test("counts only the native checkpoint and retained tail as active context", async () => {
    const marker = compactionPart("compact-user") as Part & {
      tail_start_id?: string;
    };
    marker.tail_start_id = "tail-user";
    const messages = [
      ...ordinaryTurn("hidden"),
      ...ordinaryTurn("tail"),
      message("compact-user", "user", [marker]),
      nativeSummaryMessage("native-summary", "compact-user", [
        textPart("summary", "native-summary", "checkpoint"),
      ]),
    ];
    const v2 = {
      session: { messages: async () => ({ data: messages }) },
    } as unknown as V2Client;

    const tokens = await countNativeVisibleTokens(v2, "session");
    const expected = [...ordinaryTurn("tail"), messages.at(-1)!].reduce(
      (total, item) => total + countPartsTokens(item.parts),
      0,
    );

    expect(tokens).toBe(expected);
  });
});

function ordinaryTurn(prefix = "turn"): MessageWithParts[] {
  return [
    message(`${prefix}-user`, "user", [
      textPart(`${prefix}-user-text`, `${prefix}-user`, `${prefix} request`),
    ]),
    message(`${prefix}-assistant`, "assistant", [
      textPart(
        `${prefix}-assistant-text`,
        `${prefix}-assistant`,
        `${prefix} result`,
      ),
    ]),
  ];
}

function message(
  id: string,
  role: "user" | "assistant",
  parts: Part[],
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "session",
      role,
    } as Message,
    parts,
  };
}

function nativeSummaryMessage(
  id: string,
  parentID: string,
  parts: Part[],
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "session",
      role: "assistant",
      parentID,
      summary: true,
      finish: "stop",
    } as Message,
    parts,
  };
}

function compactionPart(messageID: string): Part {
  return {
    id: `compaction-${messageID}`,
    sessionID: "session",
    messageID,
    type: "compaction",
    auto: false,
  };
}

function textPart(id: string, messageID: string, text: string): TextPart {
  return {
    id,
    sessionID: "session",
    messageID,
    type: "text",
    text,
  };
}

function reasoningPart(id: string, messageID: string): Part {
  return {
    id,
    sessionID: "session",
    messageID,
    type: "reasoning",
    text: "provider scratchpad",
    time: { start: 1, end: 2 },
  };
}

function sourceSession(): Session {
  return {
    id: "session",
    title: "Source",
    model: { providerID: "provider", id: "model" },
  } as Session;
}
