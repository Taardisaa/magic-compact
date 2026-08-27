import type { AssistantMessage, Session, TextPart } from "@opencode-ai/sdk/v2";
import { unwrap, type V2Client } from "../api";
import { createCompactionPlan, createTrimPlan, type Turn } from "./plan";
import { trimToolPartsForSummary } from "./prune";
import {
  buildBatchCompactionPrompt,
  buildCompactionPrompt,
  buildSummaryRepairPrompt,
} from "./template";
import { countSessionTokens, countTextTokens } from "../stats/tokenize";
import type {
  CompactProgressReporter,
  CompactProgressUpdate,
} from "./progress";

const SUMMARY_OUTPUT_RESERVE_CAP = 32_768;
const BATCH_CONTEXT_FRACTION = 0.7;
const PRIOR_BATCH_SUMMARY_COUNT = 2;

type SummaryBudget = {
  context: number;
  reservedOutput: number;
  maxPromptTokens: number;
  batchPromptLimit: number;
};

type SummaryBatch = {
  start: number;
  end: number;
};

export type CompactSessionResult = {
  summarizedTurns: Turn[];
  nextTurn: Turn | null;
  summaries: string[];
};

export async function compactSession(
  v2: V2Client,
  session: Session,
  sessionID: string,
  keepTurns: number,
  reportProgress?: CompactProgressReporter,
): Promise<CompactSessionResult> {
  const plan = await createCompactionPlan(v2, sessionID, keepTurns);
  await reportCompactProgress(reportProgress, {
    phase: "preparing",
    completedTurns: 0,
    totalTurns: plan.summarizedTurns.length,
  });
  const summaries = await generateSummariesInEphemeralSession(
    v2,
    session,
    plan.summarizedTurns,
    plan.nextTurn,
    keepTurns,
    reportProgress,
  );

  await reportCompactProgress(reportProgress, {
    phase: "applying",
    completedTurns: plan.summarizedTurns.length,
    totalTurns: plan.summarizedTurns.length,
  });
  return {
    summarizedTurns: plan.summarizedTurns,
    nextTurn: plan.nextTurn,
    summaries,
  };
}

async function generateSummariesInEphemeralSession(
  v2: V2Client,
  session: Session,
  turns: Turn[],
  nextTurn: Turn | null,
  keepTurns: number,
  reportProgress?: CompactProgressReporter,
): Promise<string[]> {
  // Fork the source session so the summarizer sees the full conversation it
  // is asked to summarize. A freshly created session has no history: the
  // model would only receive the truncated user lines embedded in the
  // template and could not produce faithful per-turn summaries.
  const compactionSession = unwrap(
    await v2.session.fork({ sessionID: session.id }),
  );

  try {
    unwrap(
      await v2.session.update({
        sessionID: compactionSession.id,
        title: `[TEMP] ${session.title}`,
        ...(session.permission ? { permission: session.permission } : {}),
      }),
    );

    // Claude Code clears stale tool output before its one-shot summary call.
    // Do the same only inside this disposable fork so a nearly-full source
    // session still has enough room to generate its summary.
    const temporaryTrimPlan = await createTrimPlan(v2, compactionSession.id, 0);
    await trimToolPartsForSummary(
      { v2, sessionID: compactionSession.id },
      temporaryTrimPlan.trimmedTurns,
    );

    const temporarySummaryPlan = await createCompactionPlan(
      v2,
      compactionSession.id,
      keepTurns,
    );
    if (temporarySummaryPlan.summarizedTurns.length !== turns.length) {
      throw new Error(
        "Temporary summary fork no longer matches the source compaction plan.",
      );
    }

    const summarySession = resolveSummarySession(
      session,
      temporarySummaryPlan.summarizedTurns,
    );

    return await generateSummaries(
      v2,
      compactionSession.id,
      summarySession,
      turns,
      nextTurn,
      temporarySummaryPlan.summarizedTurns,
      reportProgress,
    );
  } finally {
    unwrap(
      await v2.session.delete({
        sessionID: compactionSession.id,
      }),
    );
  }
}

function resolveSummarySession(session: Session, turns: Turn[]): Session {
  if (session.model && session.agent) {
    return session;
  }

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const assistants = turns[turnIndex]?.assistants ?? [];
    for (
      let assistantIndex = assistants.length - 1;
      assistantIndex >= 0;
      assistantIndex--
    ) {
      const info = assistants[assistantIndex]?.info;
      if (info?.role !== "assistant") {
        continue;
      }
      const derivedAgent = info.agent || undefined;
      const derivedModel =
        info.providerID && info.modelID
          ? {
              providerID: info.providerID,
              id: info.modelID,
              ...(info.variant ? { variant: info.variant } : {}),
            }
          : undefined;
      if (
        (!derivedAgent || session.agent)
        && (!derivedModel || session.model)
      ) {
        continue;
      }
      return {
        ...session,
        ...(session.agent || !derivedAgent ? {} : { agent: derivedAgent }),
        ...(session.model ? {} : derivedModel ? { model: derivedModel } : {}),
      };
    }
  }
  return session;
}

async function generateSummaries(
  v2: V2Client,
  sessionID: string,
  sourceSession: Session,
  turns: Turn[],
  nextTurn: Turn | null,
  transcriptTurns: Turn[],
  reportProgress?: CompactProgressReporter,
): Promise<string[]> {
  const variant = sourceSession.model?.variant;
  const prompt = async (
    targetSessionID: string,
    text: string,
  ): Promise<string> => {
    const response = unwrap(
      await v2.session.prompt({
        sessionID: targetSessionID,
        ...(sourceSession.agent ? { agent: sourceSession.agent } : {}),
        ...(sourceSession.model
          ? {
              model: {
                providerID: sourceSession.model.providerID,
                modelID: sourceSession.model.id,
              },
            }
          : {}),
        ...(variant && variant !== "default" ? { variant } : {}),
        parts: [
          {
            type: "text",
            text,
          },
        ],
      }),
    );

    if (response.info.error) {
      throw new SummaryProviderError(response.info.error);
    }

    return response.parts
      .filter((part): part is TextPart => part.type === "text")
      .map(part => part.text)
      .join("\n");
  };

  const compactionPrompt = buildCompactionPrompt(turns, nextTurn);
  const budget = await getSummaryBudget(v2, sourceSession);
  const fullRequestFits = await summaryRequestFits(
    v2,
    sessionID,
    compactionPrompt,
    budget,
  );

  if (budget && fullRequestFits === false) {
    return generateSummariesInBatches(
      v2,
      sourceSession,
      turns,
      nextTurn,
      transcriptTurns,
      budget,
      prompt,
      reportProgress,
    );
  }

  await reportCompactProgress(reportProgress, {
    phase: "summarizing",
    completedTurns: 0,
    totalTurns: turns.length,
    detail: `processing turns 1-${turns.length}`,
  });
  let firstResponse: string;
  try {
    firstResponse = await prompt(sessionID, compactionPrompt);
  } catch (error) {
    if (budget && isContextOverflow(error) && turns.length > 1) {
      return generateSummariesInBatches(
        v2,
        sourceSession,
        turns,
        nextTurn,
        transcriptTurns,
        budget,
        prompt,
        reportProgress,
      );
    }
    throw error;
  }
  if (!firstResponse.trim()) {
    if (budget && turns.length > 1) {
      return generateSummariesInBatches(
        v2,
        sourceSession,
        turns,
        nextTurn,
        transcriptTurns,
        budget,
        prompt,
        reportProgress,
      );
    }
    throw new Error(
      "Summary model returned no text. The provider likely rejected or aborted the request before XML generation.",
    );
  }

  const summaries = await parseOrRepairSummaries(
    v2,
    sourceSession,
    turns,
    nextTurn,
    firstResponse,
    prompt,
    async () =>
      reportCompactProgress(reportProgress, {
        phase: "repairing",
        completedTurns: 0,
        totalTurns: turns.length,
        detail: `turns 1-${turns.length}`,
      }),
  );
  await reportCompactProgress(reportProgress, {
    phase: "summarizing",
    completedTurns: turns.length,
    totalTurns: turns.length,
  });
  return summaries;
}

async function generateSummariesInBatches(
  v2: V2Client,
  sourceSession: Session,
  turns: Turn[],
  nextTurn: Turn | null,
  transcriptTurns: Turn[],
  budget: SummaryBudget,
  prompt: (sessionID: string, text: string) => Promise<string>,
  reportProgress?: CompactProgressReporter,
): Promise<string[]> {
  const batches = planSummaryBatches(
    turns,
    nextTurn,
    transcriptTurns,
    budget.batchPromptLimit,
  );
  const summaries: string[] = [];

  for (const batch of batches) {
    const batchSummaries = await summarizeBatchRange(
      v2,
      sourceSession,
      turns,
      nextTurn,
      transcriptTurns,
      batch.start,
      batch.end,
      tail(summaries, PRIOR_BATCH_SUMMARY_COUNT),
      budget,
      prompt,
      reportProgress,
    );
    summaries.push(...batchSummaries);
  }

  if (summaries.length !== turns.length) {
    throw new Error(
      `Batched summary count mismatch: expected ${turns.length}, received ${summaries.length}.`,
    );
  }
  return summaries;
}

function planSummaryBatches(
  turns: Turn[],
  nextTurn: Turn | null,
  transcriptTurns: Turn[],
  promptLimit: number,
): SummaryBatch[] {
  const batches: SummaryBatch[] = [];
  let start = 0;

  while (start < turns.length) {
    let end = start + 1;
    while (end < turns.length) {
      const candidateEnd = end + 1;
      const candidatePrompt = buildBatchCompactionPrompt(
        turns.slice(start, candidateEnd),
        turns[candidateEnd] ?? nextTurn,
        transcriptTurns.slice(start, candidateEnd),
        [],
      );
      if (countTextTokens(candidatePrompt) > promptLimit) {
        break;
      }
      end = candidateEnd;
    }
    batches.push({ start, end });
    start = end;
  }

  return batches;
}

async function summarizeBatchRange(
  v2: V2Client,
  sourceSession: Session,
  turns: Turn[],
  nextTurn: Turn | null,
  transcriptTurns: Turn[],
  start: number,
  end: number,
  priorSummaries: string[],
  budget: SummaryBudget,
  prompt: (sessionID: string, text: string) => Promise<string>,
  reportProgress?: CompactProgressReporter,
): Promise<string[]> {
  const targetTurns = turns.slice(start, end);
  const targetTranscript = transcriptTurns.slice(start, end);
  const boundaryTurn = turns[end] ?? nextTurn;
  const batchPrompt = buildBatchCompactionPrompt(
    targetTurns,
    boundaryTurn,
    targetTranscript,
    priorSummaries,
  );

  if (countTextTokens(batchPrompt) > budget.maxPromptTokens) {
    return splitOrFailBatch(
      "estimated batch input still exceeds the safe model budget",
      v2,
      sourceSession,
      turns,
      nextTurn,
      transcriptTurns,
      start,
      end,
      priorSummaries,
      budget,
      prompt,
      reportProgress,
    );
  }

  await reportCompactProgress(reportProgress, {
    phase: "summarizing",
    completedTurns: start,
    totalTurns: turns.length,
    detail: `processing turns ${start + 1}-${end}`,
  });
  let response: string;
  try {
    response = await promptInFreshSession(
      v2,
      sourceSession,
      `[TEMP SUMMARY BATCH ${start + 1}-${end}] ${sourceSession.title}`,
      batchPrompt,
      prompt,
    );
  } catch (error) {
    if (isContextOverflow(error)) {
      return splitOrFailBatch(
        errorMessage(error),
        v2,
        sourceSession,
        turns,
        nextTurn,
        transcriptTurns,
        start,
        end,
        priorSummaries,
        budget,
        prompt,
        reportProgress,
      );
    }
    throw error;
  }

  if (!response.trim()) {
    return splitOrFailBatch(
      "summary provider returned no text for the batch",
      v2,
      sourceSession,
      turns,
      nextTurn,
      transcriptTurns,
      start,
      end,
      priorSummaries,
      budget,
      prompt,
      reportProgress,
    );
  }

  const summaries = await parseOrRepairSummaries(
    v2,
    sourceSession,
    targetTurns,
    boundaryTurn,
    response,
    prompt,
    async () =>
      reportCompactProgress(reportProgress, {
        phase: "repairing",
        completedTurns: start,
        totalTurns: turns.length,
        detail: `turns ${start + 1}-${end}`,
      }),
  );
  await reportCompactProgress(reportProgress, {
    phase: "summarizing",
    completedTurns: end,
    totalTurns: turns.length,
  });
  return summaries;
}

async function splitOrFailBatch(
  reason: string,
  v2: V2Client,
  sourceSession: Session,
  turns: Turn[],
  nextTurn: Turn | null,
  transcriptTurns: Turn[],
  start: number,
  end: number,
  priorSummaries: string[],
  budget: SummaryBudget,
  prompt: (sessionID: string, text: string) => Promise<string>,
  reportProgress?: CompactProgressReporter,
): Promise<string[]> {
  if (end - start <= 1) {
    throw new SummaryContextBudgetError(
      `Magic Compact cannot fit assistant turn ${start + 1} into an isolated summary batch: ${reason}. Run OpenCode /compact for this session.`,
    );
  }

  const middle = start + Math.floor((end - start) / 2);
  const first = await summarizeBatchRange(
    v2,
    sourceSession,
    turns,
    nextTurn,
    transcriptTurns,
    start,
    middle,
    priorSummaries,
    budget,
    prompt,
    reportProgress,
  );
  const second = await summarizeBatchRange(
    v2,
    sourceSession,
    turns,
    nextTurn,
    transcriptTurns,
    middle,
    end,
    tail([...priorSummaries, ...first], PRIOR_BATCH_SUMMARY_COUNT),
    budget,
    prompt,
    reportProgress,
  );
  return [...first, ...second];
}

async function parseOrRepairSummaries(
  v2: V2Client,
  sourceSession: Session,
  turns: Turn[],
  nextTurn: Turn | null,
  response: string,
  prompt: (sessionID: string, text: string) => Promise<string>,
  reportRepair?: () => Promise<void>,
): Promise<string[]> {
  try {
    return parseSummaries(response, turns.length);
  } catch (firstError) {
    await reportRepair?.();
    const repairResponse = await repairSummaryInFreshSession(
      v2,
      sourceSession,
      buildSummaryRepairPrompt(turns, nextTurn, response),
      prompt,
    );
    if (!repairResponse.trim()) {
      throw new Error(
        `Summary XML repair returned no text. Initial failure: ${errorMessage(firstError)}`,
        { cause: firstError },
      );
    }
    try {
      return parseSummaries(repairResponse, turns.length);
    } catch (repairError) {
      throw new Error(
        `Summary XML parsing failed after one repair attempt. Initial failure: ${errorMessage(firstError)} Repair failure: ${errorMessage(repairError)}`,
        { cause: repairError },
      );
    }
  }
}

async function reportCompactProgress(
  reporter: CompactProgressReporter | undefined,
  update: CompactProgressUpdate,
): Promise<void> {
  if (!reporter) {
    return;
  }
  try {
    await reporter(update);
  } catch {
    // Progress reporting is deliberately non-fatal.
  }
}

function tail<T>(values: T[], count: number): T[] {
  return values.slice(Math.max(0, values.length - count));
}

async function repairSummaryInFreshSession(
  v2: V2Client,
  sourceSession: Session,
  repairPrompt: string,
  prompt: (sessionID: string, text: string) => Promise<string>,
): Promise<string> {
  return promptInFreshSession(
    v2,
    sourceSession,
    `[TEMP XML REPAIR] ${sourceSession.title}`,
    repairPrompt,
    prompt,
  );
}

async function promptInFreshSession(
  v2: V2Client,
  sourceSession: Session,
  title: string,
  promptText: string,
  prompt: (sessionID: string, text: string) => Promise<string>,
): Promise<string> {
  const temporarySession = unwrap(
    await v2.session.create({
      title,
      ...(sourceSession.agent ? { agent: sourceSession.agent } : {}),
      ...(sourceSession.model
        ? {
            model: {
              providerID: sourceSession.model.providerID,
              id: sourceSession.model.id,
              ...(sourceSession.model.variant
                ? { variant: sourceSession.model.variant }
                : {}),
            },
          }
        : {}),
      ...(sourceSession.permission
        ? { permission: sourceSession.permission }
        : {}),
    }),
  );

  try {
    return await prompt(temporarySession.id, promptText);
  } finally {
    unwrap(await v2.session.delete({ sessionID: temporarySession.id }));
  }
}

async function getSummaryBudget(
  v2: V2Client,
  sourceSession: Session,
): Promise<SummaryBudget | null> {
  if (!sourceSession.model) {
    return null;
  }

  try {
    const providers = unwrap(await v2.provider.list());
    const provider = providers.all.find(
      candidate => candidate.id === sourceSession.model?.providerID,
    );
    const model = provider?.models[sourceSession.model.id];
    if (!model) {
      return null;
    }

    const reservedOutput = Math.min(
      model.limit.output,
      SUMMARY_OUTPUT_RESERVE_CAP,
    );
    const safetyMargin = Math.min(
      8_192,
      Math.max(1_024, Math.floor(model.limit.context * 0.05)),
    );
    const maxPromptTokens = Math.max(
      1,
      model.limit.context - reservedOutput - safetyMargin,
    );
    return {
      context: model.limit.context,
      reservedOutput,
      maxPromptTokens,
      batchPromptLimit: Math.min(
        maxPromptTokens,
        Math.floor(model.limit.context * BATCH_CONTEXT_FRACTION),
      ),
    };
  } catch {
    return null;
  }
}

async function summaryRequestFits(
  v2: V2Client,
  sessionID: string,
  prompt: string,
  budget: SummaryBudget | null,
): Promise<boolean | null> {
  if (!budget) {
    return null;
  }
  try {
    const estimatedInput =
      (await countSessionTokens(v2, sessionID)) + countTextTokens(prompt);
    return estimatedInput + budget.reservedOutput <= budget.context;
  } catch {
    return null;
  }
}

class SummaryContextBudgetError extends Error {}

class SummaryProviderError extends Error {
  constructor(readonly providerError: NonNullable<AssistantMessage["error"]>) {
    super(formatProviderError(providerError));
  }
}

function isContextOverflow(error: unknown): boolean {
  if (
    error instanceof SummaryProviderError
    && error.providerError.name === "ContextOverflowError"
  ) {
    return true;
  }
  return /context.{0,40}(overflow|exceed|length|limit)|maximum context/i.test(
    errorMessage(error),
  );
}

function formatProviderError(
  error: NonNullable<AssistantMessage["error"]>,
): string {
  const message =
    "message" in error.data && typeof error.data.message === "string"
      ? `: ${error.data.message}`
      : "";
  return `Summary provider failed with ${error.name}${message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSummaries(responseText: string, expectedCount: number): string[] {
  const summary = extractSummaryXml(responseText);
  // Models regularly append one unrequested summary for the trailing
  // next-turn <user> anchor. Pairing each echoed <user> with its following
  // <assistant> and taking the first expectedCount pairs ignores that extra
  // block while still failing loudly on a true miss.
  const segments = [
    ...summary.matchAll(/<(user|assistant)>([\s\S]*?)<\/\1>/g),
  ].map(match => ({ tag: match[1]!, text: match[2]!.trim() }));
  const matches: string[] = [];
  for (
    let index = 0;
    index < segments.length && matches.length < expectedCount;
    index++
  ) {
    const current = segments[index]!;
    const next = segments[index + 1];
    if (current.tag === "user" && next?.tag === "assistant") {
      matches.push(next.text);
      index++;
    }
  }

  if (matches.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} summaries, received ${matches.length} user/assistant pairs.`,
    );
  }

  return matches;
}

function extractSummaryXml(responseText: string): string {
  const start = responseText.indexOf("<summary>");
  const end = responseText.lastIndexOf("</summary>");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "Summary response did not include a complete <summary> block.",
    );
  }
  return responseText.slice(start, end + "</summary>".length);
}
