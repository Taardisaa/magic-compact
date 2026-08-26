import { describe, expect, test } from "bun:test";
import type { TextPart } from "@opencode-ai/sdk/v2";
import type { V2Client } from "../src/api";
import { formatCompactProgress } from "../src/compact/progress";
import {
  deleteProgressNotice,
  injectProgressNotice,
  updateProgressNotice,
} from "../src/compact/session";

describe("magic compact progress notice", () => {
  test("formats completed assistant turns and the active range", () => {
    expect(
      formatCompactProgress({
        phase: "summarizing",
        completedTurns: 6,
        totalTurns: 18,
        detail: "processing turns 7-10",
      }),
    ).toBe(
      "Magic Compact: Summarizing · 6/18 assistant turns (33%) · processing turns 7-10",
    );
  });

  test("updates the original text part and then deletes its message", async () => {
    const promptRequests: Record<string, unknown>[] = [];
    const partUpdates: Record<string, unknown>[] = [];
    const deletedMessages: Record<string, unknown>[] = [];
    const initialPart = progressPart(
      "Magic Compact: Preparing · 0/4 assistant turns (0%)",
    );
    const v2 = {
      session: {
        prompt: async (request: Record<string, unknown>) => {
          promptRequests.push(request);
          return {
            data: {
              info: { id: "progress-message" },
              parts: [initialPart],
            },
          };
        },
        deleteMessage: async (request: Record<string, unknown>) => {
          deletedMessages.push(request);
          return { data: true };
        },
      },
      part: {
        update: async (request: Record<string, unknown>) => {
          partUpdates.push(request);
          return { data: request["part"] };
        },
      },
    } as unknown as V2Client;

    const notice = await injectProgressNotice(v2, "session", 4);
    await updateProgressNotice(v2, "session", notice, {
      phase: "summarizing",
      completedTurns: 2,
      totalTurns: 4,
      detail: "processing turns 3-4",
    });
    await deleteProgressNotice(v2, "session", notice);

    const promptParts = promptRequests[0]?.["parts"] as TextPart[];
    expect(promptParts[0]?.text).toBe(
      "Magic Compact: Preparing · 0/4 assistant turns (0%)",
    );
    const updatedPart = partUpdates[0]?.["part"] as TextPart;
    expect(updatedPart.text).toBe(
      "Magic Compact: Summarizing · 2/4 assistant turns (50%) · processing turns 3-4",
    );
    expect(partUpdates[0]).toMatchObject({
      sessionID: "session",
      messageID: "progress-message",
      partID: "progress-part",
    });
    expect(deletedMessages).toEqual([
      { sessionID: "session", messageID: "progress-message" },
    ]);
  });
});

function progressPart(text: string): TextPart {
  return {
    id: "progress-part",
    sessionID: "session",
    messageID: "progress-message",
    type: "text",
    text,
    ignored: true,
    metadata: { magicCompact: { progress: true } },
  };
}
