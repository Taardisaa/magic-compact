import { describe, expect, test } from "bun:test";
import type { Message, Part, Session, TextPart } from "@opencode-ai/sdk/v2";
import type { V2Client } from "../src/api";
import type { MessageWithParts } from "../src/compact/plan";
import {
  DETAILED_SUMMARY_TURN_LIMIT,
  ROLLUP_TRIGGER_SUMMARY_COUNT,
  rollupCompactedSummaries,
} from "../src/compact/rollup";

describe("historical summary rollup", () => {
  test("does nothing while the detailed summary count is within the cap", async () => {
    const messages = summarizedConversation(ROLLUP_TRIGGER_SUMMARY_COUNT);
    let created = 0;
    const v2 = {
      session: {
        messages: async () => ({ data: messages }),
        create: async () => {
          created += 1;
          return { data: { id: "temp" } };
        },
      },
    } as unknown as V2Client;

    const result = await rollupCompactedSummaries(
      v2,
      sourceSession(),
      "session",
    );

    expect(result.rolledUpSummaries).toBe(0);
    expect(result.remainingDetailedSummaries).toBe(
      ROLLUP_TRIGGER_SUMMARY_COUNT,
    );
    expect(created).toBe(0);
  });

  test("replaces the oldest summaries with one bounded retrievable rollup", async () => {
    const messages = summarizedConversation(ROLLUP_TRIGGER_SUMMARY_COUNT + 1);
    const deletedMessages: string[] = [];
    const deletedParts: string[] = [];
    const updatedParts: Part[] = [];
    const archived: string[] = [];
    const deletedSessions: string[] = [];
    const v2 = {
      session: {
        messages: async () => ({ data: messages }),
        create: async () => ({ data: { id: "temp" } }),
        prompt: async () => ({
          data: {
            info: {},
            parts: [responseText("<rollup>Dense durable history.</rollup>")],
          },
        }),
        delete: async (input: { sessionID: string }) => {
          deletedSessions.push(input.sessionID);
          return { data: true };
        },
        deleteMessage: async (input: { messageID: string }) => {
          deletedMessages.push(input.messageID);
          return { data: true };
        },
      },
      part: {
        delete: async (input: { partID: string }) => {
          deletedParts.push(input.partID);
          return { data: true };
        },
        update: async (input: { part: Part }) => {
          updatedParts.push(input.part);
          return { data: input.part };
        },
      },
    } as unknown as V2Client;

    const result = await rollupCompactedSummaries(
      v2,
      sourceSession(),
      "session",
      {
        allocateOmission: async (_sessionID, entry) => {
          archived.push(entry.content);
          return "omitted-001";
        },
      },
    );

    const rolledUp =
      ROLLUP_TRIGGER_SUMMARY_COUNT + 1 - DETAILED_SUMMARY_TURN_LIMIT;
    expect(result).toEqual({
      rolledUpSummaries: rolledUp,
      remainingDetailedSummaries: DETAILED_SUMMARY_TURN_LIMIT,
    });
    expect(deletedMessages).toHaveLength(rolledUp - 1);
    expect(deletedParts).toEqual([`archive_ast_${rolledUp}`]);
    expect(updatedParts).toHaveLength(2);
    expect(updatedParts[0]).toMatchObject({
      id: `summary_ast_${rolledUp}`,
      text: "Dense durable history.",
      metadata: { magicCompact: { summary: true, rollup: true } },
    });
    expect(updatedParts[1]).toMatchObject({
      id: `prt_-magic_rollup_archive_ast_${rolledUp}`,
      metadata: { magicCompact: { rollupArchive: true } },
    });
    expect((updatedParts[1] as TextPart).text).toContain("omitted-001");
    expect(archived).toHaveLength(1);
    expect(JSON.parse(archived[0] ?? "[]")).toHaveLength(rolledUp);
    expect(deletedSessions).toEqual(["temp"]);
  });

  test("always deletes the temporary rollup session when prompting fails", async () => {
    const messages = summarizedConversation(ROLLUP_TRIGGER_SUMMARY_COUNT + 1);
    const deletedSessions: string[] = [];
    const v2 = {
      session: {
        messages: async () => ({ data: messages }),
        create: async () => ({ data: { id: "temp" } }),
        prompt: async () => {
          throw new Error("provider failed");
        },
        delete: async (input: { sessionID: string }) => {
          deletedSessions.push(input.sessionID);
          return { data: true };
        },
      },
    } as unknown as V2Client;

    await expect(
      rollupCompactedSummaries(v2, sourceSession(), "session"),
    ).rejects.toThrow("provider failed");
    expect(deletedSessions).toEqual(["temp"]);
  });
});

function summarizedConversation(count: number): MessageWithParts[] {
  const messages: MessageWithParts[] = [];
  for (let index = 1; index <= count; index++) {
    const assistantID = `ast_${index}`;
    messages.push(message(`usr_${index}`, "user", []));
    messages.push(
      message(assistantID, "assistant", [
        summaryPart(assistantID),
        archivePart(assistantID),
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
  return { info: { id, role } as Message, parts };
}

function summaryPart(messageID: string): TextPart {
  return {
    id: `summary_${messageID}`,
    sessionID: "session",
    messageID,
    type: "text",
    text: `Summary ${messageID}`,
    synthetic: true,
    metadata: { magicCompact: { summary: true } },
  };
}

function archivePart(messageID: string): TextPart {
  return {
    id: `archive_${messageID}`,
    sessionID: "session",
    messageID,
    type: "text",
    text: `Archive ${messageID}`,
    synthetic: true,
    metadata: { magicCompact: { toolArchive: true } },
  };
}

function responseText(text: string): TextPart {
  return {
    id: "response",
    sessionID: "temp",
    messageID: "response-message",
    type: "text",
    text,
  };
}

function sourceSession(): Session {
  return {
    id: "session",
    title: "Source",
    agent: "build",
    model: { providerID: "provider", id: "model" },
  } as Session;
}
