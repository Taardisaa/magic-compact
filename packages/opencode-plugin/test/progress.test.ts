import { describe, expect, test } from "bun:test";
import type { V2Client } from "../src/api";
import {
  formatCompactProgress,
  showCompactProgressToast,
} from "../src/compact/progress";

describe("magic compact progress toast", () => {
  test("formats completed assistant turns and the active range", () => {
    expect(
      formatCompactProgress({
        phase: "summarizing",
        completedTurns: 6,
        totalTurns: 18,
        detail: "processing turns 7-10",
      }),
    ).toBe(
      "Summarizing · 6/18 assistant turns (33%) · processing turns 7-10",
    );
  });

  test("publishes each update as a long-lived replaceable TUI toast", async () => {
    const toasts: Record<string, unknown>[] = [];
    const v2 = {
      tui: {
        showToast: async (request: Record<string, unknown>) => {
          toasts.push(request);
          return { data: true };
        },
      },
    } as unknown as V2Client;

    await showCompactProgressToast(v2, {
      phase: "summarizing",
      completedTurns: 2,
      totalTurns: 4,
      detail: "processing turns 3-4",
    });

    expect(toasts).toEqual([
      {
        title: "Magic Compact",
        message:
          "Summarizing · 2/4 assistant turns (50%) · processing turns 3-4",
        variant: "info",
        duration: 3_600_000,
      },
    ]);
  });
});
