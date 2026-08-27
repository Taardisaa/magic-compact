import type { V2Client } from "../api";

export type CompactProgressPhase =
  | "preparing"
  | "summarizing"
  | "repairing"
  | "applying";

export type CompactProgressUpdate = {
  phase: CompactProgressPhase;
  completedTurns: number;
  totalTurns: number;
  detail?: string;
};

export type CompactProgressReporter = (
  update: CompactProgressUpdate,
) => Promise<void> | void;

const PHASE_LABELS: Record<CompactProgressPhase, string> = {
  preparing: "Preparing",
  summarizing: "Summarizing",
  repairing: "Repairing XML",
  applying: "Applying summaries",
};

export function formatCompactProgress(update: CompactProgressUpdate): string {
  const total = Math.max(0, update.totalTurns);
  const completed = Math.min(total, Math.max(0, update.completedTurns));
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const detail = update.detail ? ` · ${update.detail}` : "";

  return `${PHASE_LABELS[update.phase]} · ${completed}/${total} assistant turns (${percent}%)${detail}`;
}

export async function showCompactProgressToast(
  v2: V2Client,
  update: CompactProgressUpdate,
): Promise<void> {
  await v2.tui.showToast({
    title: "Magic Compact",
    message: formatCompactProgress(update),
    variant: "info",
    // Each progress event replaces the current toast. A long duration keeps
    // slow provider batches visible until the next event arrives.
    duration: 3_600_000,
  });
}
