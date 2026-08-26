import type { Session, TextPart } from "@opencode-ai/sdk/v2";
import { unwrap, type V2Client } from "../api";
import {
  BOUNDARY_METADATA,
  POST_COMPACTION_NOTICE,
  boundaryPartID,
} from "./constants";
import type { MessageWithParts, Turn } from "./plan";
import { copyCache } from "../storage/omission";
import type { ConversationStats } from "../storage/stats";
import { copyStats, writeStats } from "../storage/stats";
import {
  STATS_METADATA,
  statsMessage,
  trimStatsMessage,
} from "../stats/constants";
import { formatCompactProgress, type CompactProgressUpdate } from "./progress";

export type MagicCompactMetadata = {
  sourceSessionId: string;
  compactedAt: number;
  compactionCount: number;
};

export type ProgressNotice = {
  messageID: string;
  part: TextPart;
};

export async function createBackup(
  v2: V2Client,
  sourceSession: Session,
  compactionCount: number,
): Promise<Session> {
  const backupSession = unwrap(
    await v2.session.fork({ sessionID: sourceSession.id }),
  );

  await copyCache(sourceSession.id, backupSession.id);
  await copyStats(sourceSession.id, backupSession.id);
  await updateForkMetadata(
    v2,
    sourceSession,
    sourceSession.id,
    backupSession.id,
    compactionCount,
  );

  return backupSession;
}

export async function applyBackup(
  v2: V2Client,
  originalSession: Session,
  backupSession: Session,
): Promise<void> {
  unwrap(
    await v2.session.update({
      sessionID: backupSession.id,
      title: originalSession.title,
    }),
  );
  unwrap(
    await v2.session.delete({
      sessionID: originalSession.id,
    }),
  );
  await v2.tui.selectSession({
    sessionID: backupSession.id,
  });
}

export async function injectProgressNotice(
  v2: V2Client,
  sessionID: string,
  totalTurns: number,
): Promise<ProgressNotice> {
  const message = unwrap(
    await v2.session.prompt({
      sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: formatCompactProgress({
            phase: "preparing",
            completedTurns: 0,
            totalTurns,
          }),
          ignored: true,
          metadata: {
            magicCompact: {
              progress: true,
            },
          },
        },
      ],
    }),
  );

  const part = message.parts.find(
    (candidate): candidate is TextPart => candidate.type === "text",
  );
  if (!part) {
    throw new Error("Magic Compact progress notice has no text part.");
  }

  return { messageID: message.info.id, part };
}

export async function updateProgressNotice(
  v2: V2Client,
  sessionID: string,
  notice: ProgressNotice,
  update: CompactProgressUpdate,
): Promise<void> {
  const part: TextPart = {
    ...notice.part,
    sessionID,
    messageID: notice.messageID,
    text: formatCompactProgress(update),
  };

  notice.part = unwrap(
    await v2.part.update({
      sessionID,
      messageID: notice.messageID,
      partID: part.id,
      part,
    }),
  ) as TextPart;
}

export async function deleteProgressNotice(
  v2: V2Client,
  sessionID: string,
  notice: ProgressNotice,
): Promise<void> {
  unwrap(
    await v2.session.deleteMessage({
      sessionID,
      messageID: notice.messageID,
    }),
  );
}

export function getCompactionCount(session: Session): number {
  const metadata = session.metadata?.magicCompact as
    | MagicCompactMetadata
    | undefined;
  return metadata?.compactionCount ?? 0;
}

async function updateForkMetadata(
  v2: V2Client,
  sourceSession: Session,
  sourceSessionID: string,
  forkedSessionID: string,
  compactionCount: number,
): Promise<void> {
  const timestamp = new Date().toISOString();

  unwrap(
    await v2.session.update({
      sessionID: forkedSessionID,
      title: `[Backup] ${sourceSession.title} ${timestamp}`,
      metadata: {
        ...sourceSession.metadata,
        magicCompact: {
          sourceSessionId: sourceSessionID,
          compactedAt: Date.now(),
          compactionCount,
        },
      },
    }),
  );
}

export async function updateCompactionMetadata(
  v2: V2Client,
  session: Session,
  compactionCount: number,
): Promise<void> {
  unwrap(
    await v2.session.update({
      sessionID: session.id,
      metadata: {
        ...session.metadata,
        magicCompact: {
          compactionCount,
        },
      },
    }),
  );
}

export async function injectPostCompactionNotice(
  v2: V2Client,
  sessionID: string,
  nextTurn: Turn | null,
): Promise<void> {
  if (!nextTurn) {
    unwrap(
      await v2.session.prompt({
        sessionID,
        noReply: true,
        parts: [
          {
            type: "text",
            text: POST_COMPACTION_NOTICE,
            synthetic: true,
            metadata: BOUNDARY_METADATA,
          },
        ],
      }),
    );
    return;
  }

  const firstUser = nextTurn.user[0];
  if (!firstUser) {
    throw new Error("Next turn has no user messages.");
  }

  const part = {
    id: boundaryPartID(firstUser.info.id),
    sessionID,
    messageID: firstUser.info.id,
    type: "text",
    text: POST_COMPACTION_NOTICE,
    synthetic: true,
    metadata: BOUNDARY_METADATA,
  } satisfies TextPart;

  unwrap(
    await v2.part.update({
      sessionID,
      messageID: firstUser.info.id,
      partID: part.id,
      part,
    }),
  );
}

export async function recordPruningStats(input: {
  sessionID: string;
  sourceSessionID: string;
  tokensPruned: number;
}): Promise<ConversationStats> {
  const stats = await copyStats(input.sourceSessionID, input.sessionID);
  const nextStats = {
    ...stats,
    totalTokensPruned:
      stats.totalTokensPruned + Math.max(0, input.tokensPruned),
  };

  await writeStats(input.sessionID, nextStats);
  return nextStats;
}

export async function injectCompactStatsNotice(
  v2: V2Client,
  sessionID: string,
  beforeTokens: number,
  afterTokens: number,
  compactionCount: number,
  stats: ConversationStats,
  modelID: string | null,
): Promise<void> {
  unwrap(
    await v2.session.prompt({
      sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: statsMessage(
            compactionCount,
            beforeTokens,
            afterTokens,
            stats,
            modelID,
          ),
          ignored: true,
          metadata: STATS_METADATA,
        },
      ],
    }),
  );
}

export async function injectTrimStatsNotice(
  v2: V2Client,
  sessionID: string,
  beforeTokens: number,
  afterTokens: number,
  stats: ConversationStats,
  modelID: string | null,
): Promise<void> {
  unwrap(
    await v2.session.prompt({
      sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: trimStatsMessage(beforeTokens, afterTokens, stats, modelID),
          ignored: true,
          metadata: STATS_METADATA,
        },
      ],
    }),
  );
}

export async function reloadTurns(
  v2: V2Client,
  sessionID: string,
  turns: Turn[],
): Promise<Turn[]> {
  const messages: MessageWithParts[] = unwrap(
    await v2.session.messages({
      sessionID,
    }),
  );
  const messageByID = new Map(
    messages.map(message => [message.info.id, message]),
  );

  return turns.map(turn => ({
    user: turn.user.map(message =>
      requireMessage(messageByID, message.info.id),
    ),
    assistants: turn.assistants.map(message =>
      requireMessage(messageByID, message.info.id),
    ),
  }));
}

function requireMessage(
  messageByID: Map<string, MessageWithParts>,
  messageID: string,
): MessageWithParts {
  const message = messageByID.get(messageID);
  if (!message) {
    throw new Error(`Message not found while reloading turn: ${messageID}`);
  }

  return message;
}
