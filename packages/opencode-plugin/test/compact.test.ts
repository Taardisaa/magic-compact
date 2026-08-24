import { describe, expect, test } from "bun:test";
import type { Message, Part, Session, TextPart } from "@opencode-ai/sdk/v2";
import type { V2Client } from "../src/api";
import { compactSession } from "../src/compact/compact";
import type { MessageWithParts } from "../src/compact/plan";

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

  test("repairs one malformed summary response in the ephemeral session", async () => {
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
      sessionID: "ephemeral",
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
    expect(requests.deletes).toEqual(["ephemeral"]);
  });

  test("stops after one unsuccessful repair and deletes the ephemeral session", async () => {
    const requests = requestLog();

    await expect(
      runCompaction(session("source"), ["not xml", "still not xml"], requests),
    ).rejects.toThrow("Summary XML parsing failed after one repair attempt.");

    expect(requests.prompts).toHaveLength(2);
    expect(requests.deletes).toEqual(["ephemeral"]);
  });
});

type RequestLog = {
  prompts: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  deletes: string[];
};

async function runCompaction(
  sourceSession: Session,
  responses = [
    "<summary><user>Request</user><assistant>Completed the request.</assistant></summary>",
  ],
  requests = requestLog(),
): Promise<RequestLog> {
  let responseIndex = 0;
  const v2 = {
    session: {
      messages: async () => ({ data: compactableMessages() }),
      fork: async () => ({ data: session("ephemeral") }),
      update: async (request: Record<string, unknown>) => {
        requests.updates.push(request);
        return { data: session("ephemeral") };
      },
      prompt: async (request: Record<string, unknown>) => {
        requests.prompts.push(request);
        const text = responses[responseIndex++] ?? responses.at(-1) ?? "";
        return {
          data: {
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
      update: async ({ part }: { part: TextPart }) => ({ data: part }),
    },
  } as unknown as V2Client;

  await compactSession(v2, sourceSession, "source", 0);
  return requests;
}

function requestLog(): RequestLog {
  return { prompts: [], updates: [], deletes: [] };
}

function promptText(request: Record<string, unknown>): string {
  const parts = request["parts"] as { type: string; text: string }[];
  return parts[0]?.text ?? "";
}

function compactableMessages(): MessageWithParts[] {
  return [
    message("user", "user", [
      textPart("user-text", "source", "user", "Request"),
    ]),
    message("assistant", "assistant", []),
  ];
}

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
