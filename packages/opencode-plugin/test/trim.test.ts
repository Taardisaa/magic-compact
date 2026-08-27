import { describe, expect, test } from "bun:test";
import type { Message, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2";
import type { V2Client } from "../src/api";
import {
  createTrimPlan,
  type MessageWithParts,
  type Turn,
} from "../src/compact/plan";
import { pruneCompactedHistory, trimToolParts } from "../src/compact/prune";

describe("magic trim", () => {
  test("preserves the requested assistant-turn tail", async () => {
    const messages = [
      message("usr_1", "user", []),
      message("ast_1", "assistant", [readTool("tool_1", "first")]),
      message("usr_2", "user", []),
      message("ast_2", "assistant", [readTool("tool_2", "second")]),
      message("usr_3", "user", []),
      message("ast_3", "assistant", [readTool("tool_3", "third")]),
    ];
    const v2 = {
      session: {
        messages: async () => ({ data: messages }),
      },
    } as unknown as V2Client;

    const plan = await createTrimPlan(v2, "session", 1);

    expect(
      plan.trimmedTurns.flatMap(turn =>
        turn.assistants.map(assistant => assistant.info.id),
      ),
    ).toEqual(["ast_1", "ast_2"]);
  });

  test("marks changed tools and skips them on later trims", async () => {
    const tool = completedTool("tool_1", "todowrite", "verbose output");
    const reasoning = {
      id: "reasoning_1",
      sessionID: "session",
      messageID: "assistant",
      type: "reasoning",
      text: "unchanged",
      time: { start: 1, end: 2 },
    } satisfies Part;
    const selectedTurn = turn(tool, reasoning);
    let updates = 0;
    const v2 = {
      part: {
        update: async () => {
          updates += 1;
          return { data: tool };
        },
      },
    } as unknown as V2Client;

    expect(
      await trimToolParts({ v2, sessionID: "session" }, [selectedTurn]),
    ).toBe(1);
    expect(tool.state.status).toBe("completed");
    if (tool.state.status !== "completed") {
      throw new Error("Expected completed tool state.");
    }
    expect(tool.state.metadata["magicCompact"]).toEqual({ trimmed: true });
    expect(tool.state.output).toBe("Successfully updated todos.");
    expect(reasoning.text).toBe("unchanged");

    expect(
      await trimToolParts({ v2, sessionID: "session" }, [selectedTurn]),
    ).toBe(0);
    expect(updates).toBe(1);
  });

  test("archives and removes tools from all summarized history", async () => {
    const oldTool = readTool("tool_old", "old output");
    oldTool.messageID = "ast_old";
    const newTool = readTool("tool_new", "new output");
    newTool.messageID = "ast_new";
    const messages = [
      message("usr_old", "user", []),
      message("ast_old", "assistant", [summary("ast_old"), oldTool]),
      message("usr_boundary", "user", [boundary("usr_boundary")]),
      message("ast_new", "assistant", [summary("ast_new"), newTool]),
    ];
    const archived: string[] = [];
    const deleted: string[] = [];
    const v2 = {
      session: {
        messages: async () => ({ data: messages }),
        deleteMessage: async () => ({ data: true }),
      },
      part: {
        update: async (input: { part: Part }) => {
          if (input.part.type === "text") {
            archived.push(input.part.text);
          }
          return { data: input.part };
        },
        delete: async (input: { partID: string }) => {
          deleted.push(input.partID);
          return { data: true };
        },
      },
    } as unknown as V2Client;
    let nextID = 1;

    await pruneCompactedHistory({
      v2,
      sessionID: "session",
      allocateOmission: async () => `omitted-00${nextID++}`,
    });

    expect(deleted).toContain("tool_old");
    expect(deleted).toContain("tool_new");
    expect(archived).toHaveLength(2);
    expect(archived[0]).toContain("omitted-001");
    expect(archived[1]).toContain("omitted-002");
  });
});

function message(
  id: string,
  role: "user" | "assistant",
  parts: Part[],
): MessageWithParts {
  return {
    info: { id, role } as Message,
    parts,
  };
}

function turn(...parts: Part[]): Turn {
  return {
    user: [message("user", "user", [])],
    assistants: [message("assistant", "assistant", parts)],
  };
}

function readTool(id: string, output: string): ToolPart {
  return completedTool(id, "read", output);
}

function completedTool(id: string, tool: string, output: string): ToolPart {
  return {
    id,
    sessionID: "session",
    messageID: "assistant",
    type: "tool",
    callID: `call_${id}`,
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function summary(messageID: string): TextPart {
  return {
    id: `summary_${messageID}`,
    sessionID: "session",
    messageID,
    type: "text",
    text: `Summary for ${messageID}`,
    synthetic: true,
    metadata: { magicCompact: { summary: true } },
  };
}

function boundary(messageID: string): TextPart {
  return {
    id: `boundary_${messageID}`,
    sessionID: "session",
    messageID,
    type: "text",
    text: "boundary",
    synthetic: true,
    metadata: { magicCompact: { boundary: true } },
  };
}
