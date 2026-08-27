import type { Part } from "@opencode-ai/sdk/v2";
import { encode } from "gpt-tokenizer";
import { unwrap, type V2Client } from "../api";
import type { MessageWithParts } from "../compact/plan";

export function countTextTokens(text: string): number {
  return encode(text).length;
}

function stringifyToolContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function extractToolContent(part: Part): string[] {
  if (part.type !== "tool") {
    return [];
  }

  const contents: string[] = [];

  if (part.state.input !== undefined) {
    contents.push(stringifyToolContent(part.state.input));
  }

  if (part.state.status === "completed" && part.state.output !== undefined) {
    contents.push(stringifyToolContent(part.state.output));
  } else if (part.state.status === "error" && part.state.error) {
    contents.push(stringifyToolContent(part.state.error));
  }

  return contents;
}

function extractPartTexts(part: Part): string[] {
  switch (part.type) {
    case "text":
      return [part.text];
    case "reasoning":
      return [part.text];
    case "tool":
      return extractToolContent(part);
    case "subtask":
      return [part.prompt, part.description];
    case "file":
      return [part.url];
    case "snapshot":
      return [part.snapshot];
    case "patch":
      return part.files;
    default:
      return [];
  }
}

export function countPartsTokens(parts: Part[]): number {
  return parts
    .map(part => countTextTokens(extractPartTexts(part).join("\n\n")))
    .reduce((sum, count) => sum + count, 0);
}

export async function countSessionTokens(
  v2: V2Client,
  sessionID: string,
): Promise<number> {
  const messages = unwrap(
    await v2.session.messages({ sessionID }),
  ) as MessageWithParts[];
  const sessionTokens = messages
    .map(message => countMessageGptTokens(message))
    .reduce((sum, count) => sum + count, 0);
  return sessionTokens + estimateSystemPromptTokens(messages);
}

function estimateSystemPromptTokens(messages: MessageWithParts[]): number {
  const firstAssistant = messages.find(message => {
    if (message.info.role !== "assistant") {
      return false;
    }

    const tokens = message.info.tokens;
    return tokens.input > 0 || tokens.cache.read > 0 || tokens.cache.write > 0;
  });

  if (!firstAssistant || firstAssistant.info.role !== "assistant") {
    return 0;
  }

  const firstUser = messages.find(message => message.info.role === "user");
  const firstUserTokens = firstUser ? countMessageGptTokens(firstUser) : 0;

  const tokens = firstAssistant.info.tokens;
  const firstTokens = tokens.input + tokens.cache.read + tokens.cache.write;

  return Math.max(0, firstTokens - firstUserTokens);
}

function countMessageGptTokens(message: MessageWithParts): number {
  return countPartsTokens(message.parts);
}

// Most accurate for unmodified conversations. Do not use on modified conversations.
export async function getProviderTokens(
  v2: V2Client,
  sessionID: string,
): Promise<number | null> {
  const messages = unwrap(
    await v2.session.messages({ sessionID }),
  ) as MessageWithParts[];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.info.role !== "assistant") {
      continue;
    }

    if (!message.info.tokens) {
      continue;
    }

    const t = message.info.tokens;
    const total =
      t.input + t.output + t.reasoning + t.cache.read + t.cache.write;

    // Failed provider requests (notably context-overflow responses) can leave
    // an assistant message whose usage object is present but entirely zeroed.
    // Treat that as unavailable so callers use the local session estimate
    // instead of reporting a nonsensical 0 -> N token compaction.
    if (total > 0) {
      return total;
    }
  }

  return null;
}
