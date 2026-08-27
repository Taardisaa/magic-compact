import type {
  AssistantMessage,
  Part,
  Session,
  UserMessage,
} from "@opencode-ai/sdk/v2";
import { unwrap, type V2Client } from "./api";
import { executeMagicCompact } from "./magic-compact";
import type { MessageWithParts } from "./compact/plan";
import { isRecord } from "./util";

export const DEFAULT_AUTO_COMPACT_BUFFER_TOKENS = 49_152;

type ModelSelection = UserMessage["model"];

type AutoCompactRequest = {
  sessionID: string;
  model: ModelSelection;
  parts: Part[];
};

type AutoCompactOptions = {
  bufferTokens?: number;
  compact?: typeof executeMagicCompact;
};

type AutoCompactBudget = {
  context: number;
  threshold: number;
};

type AuthoritativeContextState =
  | { kind: "usage"; tokens: number }
  | { kind: "overflow" };

/**
 * Takes over automatic compaction only when OpenCode's native auto-compaction
 * has been explicitly disabled. The decision is based on the currently stored
 * provider usage persisted by OpenCode. It never estimates context size from
 * transcript text.
 */
export class AutoCompactController {
  private enabled = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly bufferTokens: number;
  private readonly compact: typeof executeMagicCompact;

  constructor(options: AutoCompactOptions = {}) {
    this.bufferTokens =
      options.bufferTokens ?? DEFAULT_AUTO_COMPACT_BUFFER_TOKENS;
    this.compact = options.compact ?? executeMagicCompact;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async beforeMessage(
    v2: V2Client,
    request: AutoCompactRequest,
  ): Promise<void> {
    if (!this.enabled || isInternalMagicCompactMessage(request.parts)) {
      return;
    }

    const existing = this.inFlight.get(request.sessionID);
    if (existing) {
      await existing;
      return;
    }

    const operation = this.checkAndCompact(v2, request);
    this.inFlight.set(request.sessionID, operation);
    try {
      await operation;
    } finally {
      this.inFlight.delete(request.sessionID);
    }
  }

  private async checkAndCompact(
    v2: V2Client,
    request: AutoCompactRequest,
  ): Promise<void> {
    const sourceSession = unwrap(
      await v2.session.get({ sessionID: request.sessionID }),
    );
    if (sourceSession.title.startsWith("[TEMP")) {
      return;
    }

    const budget = await getAutoCompactBudget(
      v2,
      request.model,
      this.bufferTokens,
    );
    if (!budget) {
      return;
    }

    const messages = unwrap(
      await v2.session.messages({ sessionID: request.sessionID }),
    ) as MessageWithParts[];
    const context = getAuthoritativeContextState(sourceSession, messages);
    if (!context) {
      return;
    }

    if (context.kind === "usage" && context.tokens < budget.threshold) {
      return;
    }

    const trigger =
      context.kind === "overflow"
        ? "the provider reported a context overflow"
        : `${context.tokens.toLocaleString()} / ${budget.context.toLocaleString()} provider-reported tokens`;

    await showToast(v2, {
      message: `Automatic Magic Compact triggered: ${trigger}.`,
      variant: "info",
    });

    const compacted = await this.compact(v2, request.sessionID, 0);
    if (!compacted) {
      await failAutoCompaction(
        v2,
        "No completed assistant turns are available to compact.",
      );
    }
  }
}

/**
 * Return only context state that OpenCode persisted from the provider.
 *
 * In-place compaction and trimming invalidate older usage snapshots. Mutation
 * notices form an exact ordering barrier: an assistant usage record is trusted
 * only when it occurs after the latest barrier. Legacy notices are recognized
 * by their plugin-owned text so already-compacted sessions migrate safely.
 */
export function getAuthoritativeContextState(
  session: Session,
  messages: MessageWithParts[],
): AuthoritativeContextState | null {
  const barrierIndex = messages.findLastIndex(isContextMutationNotice);
  const compactedAt = getCompactedAt(session);

  for (let index = messages.length - 1; index > barrierIndex; index -= 1) {
    const message = messages[index];
    if (!message || message.info.role !== "assistant") {
      continue;
    }

    const assistant = message.info;
    if (!assistant.time.completed) {
      continue;
    }

    const recordedAt = assistant.time.completed;
    if (
      barrierIndex === -1
      && compactedAt !== null
      && recordedAt <= compactedAt
    ) {
      return null;
    }

    const tokens = providerContextTokens(assistant);
    if (tokens > 0) {
      return { kind: "usage", tokens };
    }

    return assistant.error?.name === "ContextOverflowError"
      ? { kind: "overflow" }
      : null;
  }

  return null;
}

function providerContextTokens(message: AssistantMessage): number {
  if (message.tokens.total && message.tokens.total > 0) {
    return message.tokens.total;
  }

  return (
    message.tokens.input
    + message.tokens.output
    + message.tokens.reasoning
    + message.tokens.cache.read
    + message.tokens.cache.write
  );
}

function getCompactedAt(session: Session): number | null {
  const magicCompact = session.metadata?.["magicCompact"];
  if (!isRecord(magicCompact)) {
    return null;
  }

  const compactedAt = magicCompact["compactedAt"];
  return typeof compactedAt === "number" ? compactedAt : null;
}

function isContextMutationNotice(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return false;
  }

  return message.parts.some(part => {
    if (part.type !== "text" || !isRecord(part.metadata)) {
      return false;
    }

    const magicCompact = part.metadata["magicCompact"];
    if (!isRecord(magicCompact) || magicCompact["stats"] !== true) {
      return false;
    }

    if (magicCompact["invalidatesProviderUsage"] === true) {
      return true;
    }

    return (
      part.text.startsWith("Magic Compaction #")
      || part.text.startsWith("Magic Trim\n")
    );
  });
}

async function getAutoCompactBudget(
  v2: V2Client,
  selection: ModelSelection,
  bufferTokens: number,
): Promise<AutoCompactBudget | null> {
  try {
    const providers = unwrap(await v2.provider.list());
    const provider = providers.all.find(
      candidate => candidate.id === selection.providerID,
    );
    const model = provider?.models[selection.modelID];
    const context = model?.limit.context;
    if (!context || context <= 0) {
      return null;
    }

    const reserved = Math.max(bufferTokens, model.limit.output);
    return {
      context,
      threshold: Math.max(1, context - reserved),
    };
  } catch {
    return null;
  }
}

function isInternalMagicCompactMessage(parts: Part[]): boolean {
  return parts.some(part => {
    if (part.type !== "text" || !isRecord(part.metadata)) {
      return false;
    }
    return isRecord(part.metadata["magicCompact"]);
  });
}

async function failAutoCompaction(
  v2: V2Client,
  message: string,
): Promise<never> {
  await showToast(v2, { message, variant: "error" });
  throw new Error(`Automatic Magic Compact stopped the request: ${message}`);
}

async function showToast(
  v2: V2Client,
  input: { message: string; variant: "info" | "error" },
): Promise<void> {
  await v2.tui.showToast({
    title: "Magic Compact",
    message: input.message,
    variant: input.variant,
    duration: input.variant === "error" ? 8000 : 4000,
  });
}
