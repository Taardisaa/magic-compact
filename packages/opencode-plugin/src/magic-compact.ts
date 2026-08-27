import type { Session } from "@opencode-ai/sdk/v2";
import { unwrap, type V2Client } from "./api";
import { compactSession } from "./compact/compact";
import {
  applyBackup,
  createBackup,
  deleteProgressNotice,
  getCompactionCount,
  injectProgressNotice,
  injectCompactStatsNotice,
  recordPruningStats,
  updateCompactionMetadata,
  updateProgressNotice,
} from "./compact/session";
import type { CompactProgressReporter } from "./compact/progress";
import { createCompactionPlan } from "./compact/plan";
import {
  buildNativeSummary,
  commitNativeCompaction,
  countNativeVisibleTokens,
  needsNativeCompactionMigration,
} from "./compact/native";
import { countSessionTokens, getProviderTokens } from "./stats/tokenize";

export const COMPACT_SUCCESS = "Magic compaction successful.";
export const COMPACT_NOOP = "No assistant turns are old enough to compact.";

export async function executeMagicCompact(
  v2: V2Client,
  sessionID: string,
  keepTurns: number,
): Promise<boolean> {
  let backupSession: Session | null = null;
  let sourceSession: Session | null = null;

  try {
    // Check if there's anything to compact
    const sourcePlan = await createCompactionPlan(v2, sessionID, keepTurns);
    const migrationOnly =
      sourcePlan.summarizedTurns.length === 0
      && (await needsNativeCompactionMigration(v2, sessionID));
    if (sourcePlan.summarizedTurns.length === 0 && !migrationOnly) {
      await v2.tui.showToast({
        title: "Magic Compact",
        message: COMPACT_NOOP,
        variant: "info",
        duration: 5000,
      });
      return false;
    }

    // Create backup session
    sourceSession = unwrap(
      await v2.session.get({
        sessionID,
      }),
    );
    const currentCompactionCount = getCompactionCount(sourceSession) + 1;
    backupSession = await createBackup(
      v2,
      sourceSession,
      currentCompactionCount,
    );

    const beforeTokens =
      (await getProviderTokens(v2, sessionID))
      ?? (await countSessionTokens(v2, sessionID));

    const compacted = migrationOnly
      ? { summaries: [], summarizedTurns: [] }
      : await compactWithProgress(
          v2,
          sourceSession,
          sessionID,
          keepTurns,
          sourcePlan.summarizedTurns.length,
        );

    const preparedSummary = await buildNativeSummary(
      v2,
      sourceSession,
      sessionID,
      compacted.summaries,
    );
    await commitNativeCompaction(v2, sourceSession, sessionID, preparedSummary);

    await updateCompactionMetadata(v2, sourceSession, currentCompactionCount);
    const afterTokens = await countNativeVisibleTokens(v2, sessionID);
    const stats = await recordPruningStats({
      sessionID,
      sourceSessionID: sessionID,
      tokensPruned: beforeTokens - afterTokens,
    });

    await injectCompactStatsNotice(
      v2,
      sessionID,
      beforeTokens,
      afterTokens,
      currentCompactionCount,
      stats,
      sourceSession.model?.id ?? null,
    );

    await v2.tui.showToast({
      title: "Magic Compact",
      message: migrationOnly
        ? "Migrated the previous Magic Compact output into one native compaction block."
        : `Compacted ${compacted.summarizedTurns.length} assistant turn(s).`,
      variant: "info",
      duration: 5000,
    });
    return true;
  } catch (error) {
    if (sourceSession && backupSession) {
      await applyBackup(v2, sourceSession, backupSession);
    }

    await v2.tui.showToast({
      title: "Magic Compact Failed",
      message: String(error),
      variant: "error",
      duration: 8000,
    });
    throw error;
  }
}

async function compactWithProgress(
  v2: V2Client,
  sourceSession: Session,
  sessionID: string,
  keepTurns: number,
  totalTurns: number,
) {
  const progressNotice = await injectProgressNotice(v2, sessionID, totalTurns);
  const reportProgress: CompactProgressReporter = async update => {
    try {
      await updateProgressNotice(v2, sessionID, progressNotice, update);
    } catch {
      // Progress is best-effort UI state. A stale or unsupported part update
      // must never roll back an otherwise valid compaction.
    }
  };
  try {
    return await compactSession(
      v2,
      sourceSession,
      sessionID,
      keepTurns,
      reportProgress,
    );
  } finally {
    await deleteProgressNotice(v2, sessionID, progressNotice);
  }
}
