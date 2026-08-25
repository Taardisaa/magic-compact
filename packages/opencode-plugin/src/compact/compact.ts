import type { AssistantMessage, Session, TextPart } from "@opencode-ai/sdk/v2";
import { unwrap, type V2Client } from "../api";
import { summaryMetadata, summaryPartID } from "./constants";
import { createCompactionPlan, createTrimPlan, type Turn } from "./plan";
import { trimToolPartsForSummary } from "./prune";
import { buildCompactionPrompt, buildSummaryRepairPrompt } from "./template";
import { countSessionTokens, countTextTokens } from "../stats/tokenize";

const SUMMARY_OUTPUT_RESERVE_CAP = 32_768;

export type CompactSessionResult = {
  summarizedTurns: Turn[];
  nextTurn: Turn | null;
};

export async function compactSession(
  v2: V2Client,
  session: Session,
  sessionID: string,
  keepTurns: number,
): Promise<CompactSessionResult> {
  const plan = await createCompactionPlan(v2, sessionID, keepTurns);
  const summaries = await generateSummariesInEphemeralSession(
    v2,
    session,
    plan.summarizedTurns,
    plan.nextTurn,
  );

  await injectSummaries(v2, sessionID, plan.summarizedTurns, summaries);

  return {
    summarizedTurns: plan.summarizedTurns,
    nextTurn: plan.nextTurn,
  };
}

async function generateSummariesInEphemeralSession(
  v2: V2Client,
  session: Session,
  turns: Turn[],
  nextTurn: Turn | null,
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

    return await generateSummaries(
      v2,
      compactionSession.id,
      session,
      turns,
      nextTurn,
    );
  } finally {
    unwrap(
      await v2.session.delete({
        sessionID: compactionSession.id,
      }),
    );
  }
}

async function generateSummaries(
  v2: V2Client,
  sessionID: string,
  sourceSession: Session,
  turns: Turn[],
  nextTurn: Turn | null,
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
      throw new Error(formatProviderError(response.info.error));
    }

    return response.parts
      .filter((part): part is TextPart => part.type === "text")
      .map(part => part.text)
      .join("\n");
  };

  const compactionPrompt = buildCompactionPrompt(turns, nextTurn);
  await assertSummaryRequestFits(
    v2,
    sessionID,
    sourceSession,
    compactionPrompt,
  );

  const firstResponse = await prompt(sessionID, compactionPrompt);
  if (!firstResponse.trim()) {
    throw new Error(
      "Summary model returned no text. The provider likely rejected or aborted the request before XML generation.",
    );
  }

  try {
    return parseSummaries(firstResponse, turns.length);
  } catch (firstError) {
    const repairResponse = await repairSummaryInFreshSession(
      v2,
      sourceSession,
      buildSummaryRepairPrompt(turns, nextTurn, firstResponse),
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

async function repairSummaryInFreshSession(
  v2: V2Client,
  sourceSession: Session,
  repairPrompt: string,
  prompt: (sessionID: string, text: string) => Promise<string>,
): Promise<string> {
  const repairSession = unwrap(
    await v2.session.create({
      title: `[TEMP XML REPAIR] ${sourceSession.title}`,
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
    return await prompt(repairSession.id, repairPrompt);
  } finally {
    unwrap(await v2.session.delete({ sessionID: repairSession.id }));
  }
}

async function assertSummaryRequestFits(
  v2: V2Client,
  sessionID: string,
  sourceSession: Session,
  prompt: string,
): Promise<void> {
  if (!sourceSession.model) {
    return;
  }

  try {
    const providers = unwrap(await v2.provider.list());
    const provider = providers.all.find(
      candidate => candidate.id === sourceSession.model?.providerID,
    );
    const model = provider?.models[sourceSession.model.id];
    if (!model) {
      return;
    }

    const estimatedInput =
      (await countSessionTokens(v2, sessionID)) + countTextTokens(prompt);
    const reservedOutput = Math.min(
      model.limit.output,
      SUMMARY_OUTPUT_RESERVE_CAP,
    );
    if (estimatedInput + reservedOutput > model.limit.context) {
      throw new SummaryContextBudgetError(
        `Magic Compact still cannot fit the summary request after temporary tool-output pruning: estimated input ${estimatedInput} + reserved output ${reservedOutput} exceeds context ${model.limit.context}. Run OpenCode /compact now, or run /magic-trim and retry earlier in future sessions.`,
      );
    }
  } catch (error) {
    if (error instanceof SummaryContextBudgetError) {
      throw error;
    }
    // Model metadata and local token estimation are advisory. The provider
    // remains the final authority when either is unavailable.
  }
}

class SummaryContextBudgetError extends Error {}

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

async function injectSummaries(
  v2: V2Client,
  sessionID: string,
  compactionTurns: Turn[],
  summaries: string[],
): Promise<void> {
  for (const [index, turn] of compactionTurns.entries()) {
    const summary = summaries[index];
    if (summary === undefined) {
      throw new Error("Missing summary for assistant turn.");
    }

    const firstAssistant = turn.assistants[0];
    if (!firstAssistant) {
      throw new Error("Turn missing assistant message.");
    }

    const part = {
      id: summaryPartID(firstAssistant.info.id),
      sessionID,
      messageID: firstAssistant.info.id,
      type: "text",
      text: summary,
      metadata: summaryMetadata(),
    } satisfies TextPart;

    unwrap(
      await v2.part.update({
        sessionID,
        messageID: firstAssistant.info.id,
        partID: part.id,
        part,
      }),
    );
  }
}
