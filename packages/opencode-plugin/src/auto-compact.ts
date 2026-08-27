import type { Part, UserMessage } from "@opencode-ai/sdk/v2";
import { unwrap, type V2Client } from "./api";
import { executeMagicCompact } from "./magic-compact";
import { countPartsTokens, countSessionTokens } from "./stats/tokenize";
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

/**
 * Takes over automatic compaction only when OpenCode's native auto-compaction
 * has been explicitly disabled. The decision is based on the currently stored
 * parts rather than stale provider usage attached to historical messages.
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

    const pendingTokens = countPartsTokens(request.parts);
    const estimatedTokens =
      (await countSessionTokens(v2, request.sessionID)) + pendingTokens;
    if (estimatedTokens < budget.threshold) {
      return;
    }

    await showToast(v2, {
      message: `Automatic Magic Compact triggered at ~${estimatedTokens.toLocaleString()} / ${budget.context.toLocaleString()} tokens.`,
      variant: "info",
    });

    const compacted = await this.compact(v2, request.sessionID, 0);
    if (!compacted) {
      await failAutoCompaction(
        v2,
        "No completed assistant turns are available to compact.",
      );
    }

    const remainingTokens =
      (await countSessionTokens(v2, request.sessionID)) + pendingTokens;
    if (remainingTokens >= budget.threshold) {
      await failAutoCompaction(
        v2,
        `Context remains at ~${remainingTokens.toLocaleString()} tokens after compaction; the pending request was stopped to avoid provider overflow.`,
      );
    }
  }
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
