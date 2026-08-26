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

  return `Magic Compact: ${PHASE_LABELS[update.phase]} · ${completed}/${total} assistant turns (${percent}%)${detail}`;
}
