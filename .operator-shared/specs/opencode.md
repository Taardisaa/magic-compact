# OpenCode Behavior Specification

OpenCode-specific runtime behavior. Shared plugin behavior lives in [`operator.md`](../operator.md).

## Commands

- `/magic-compact [N]` backs up and compacts the current OpenCode session in place.
- `/magic-trim [N]` backs up and trims historical tool I/O without summarizing messages.
- `/magic-stats` injects an ignored stats notice for the current session.
- `read_omitted_content` is registered as an OpenCode plugin tool.

## Automatic Takeover

- Setting OpenCode's `compaction.auto` to `false` explicitly transfers automatic compaction ownership to Magic Compact.
- Before each ordinary user message is sent, the `chat.message` hook reads the latest completed, positive assistant usage that OpenCode persisted from the provider. Unfinished and zero-usage rows are skipped; some OpenAI-compatible proxies persist rejected requests as completed zero-usage assistant rows without a structured error.
- The automatic threshold is exactly `floor(model context × 0.85)`.
- Automatic decisions never estimate context size from transcript text or the pending message. If authoritative provider usage is unavailable, the hook does not make an automatic compaction decision.
- Compaction and trim notices invalidate older provider usage. A stored usage record is trusted only after the latest invalidation marker; legacy plugin notices are recognized for already-compacted sessions.
- When provider-reported usage reaches the threshold, or the latest assistant record contains a structured provider context-overflow error, the hook runs `/magic-compact` behavior with `N = 0` before allowing the pending message to continue.
- A `chat.params` preflight applies the same exact-usage check before every provider call, including automatic tool-loop continuations. Because the source session is busy at that point, it stops the model call, queues compaction, waits for the assistant row to finish persisting on `session.idle`, and then compacts.
- A structured `session.error` `ContextOverflowError` also queues compaction for `session.idle`. Unstructured proxy text is never classified by string matching.
- Magic Compact's internal progress, boundary, and stats messages and temporary summarization sessions never recursively trigger automatic compaction.
- Concurrent automatic checks for the same session share one in-flight operation.
- After compaction, the hook does not invent a replacement usage value. The next successful provider response becomes the new authoritative context snapshot. If no turns can be compacted, the pending request is stopped with an actionable error.
- If native `compaction.auto` is omitted or `true`, automatic Magic Compact remains disabled and commands continue to work manually.

`/magic-compact` and `/magic-trim` accept only a non-negative integer argument. `/magic-stats` accepts no arguments. Command handlers throw success, no-op, or validation messages so OpenCode does not continue sending the slash command to the LLM.

## Compaction Flow

1. Parse `N`; default is `0`.
2. Build a per-turn compaction plan for the current session.
3. Stop early with a toast if no assistant turns are eligible.
4. Load the source session and compute the next `compactionCount`.
5. Fork the session as a backup.
6. Copy omission and stats caches to the backup.
7. Rename the backup to `[Backup] ${title} ${timestamp}` and write backup metadata.
8. Measure pre-compaction tokens using provider tokens when available, otherwise local counting.
9. Insert an ignored no-reply progress message and retain its text-part handle for in-place updates.
10. Fork the source session into an ephemeral compaction session so the summarizer sees the full conversation.
11. In the ephemeral fork only, trim large completed tool inputs and outputs without writing omission-cache records.
12. When model limits are available, estimate the pruned request size.
13. If the one-shot request fits, send the XML summary prompt in the ephemeral session.
14. If it does not fit, dynamically group complete turns into safe batches and summarize each batch in a fresh, non-forked temporary session.
15. Carry the two most recent summaries into the next batch as compact cross-batch context.
16. If a batch receives a provider context-overflow error, recursively split it at a turn boundary and retry each half.
17. Abort with an actionable error if one isolated turn still cannot fit.
18. Abort immediately on other provider errors; do not misclassify them as malformed XML.
19. Parse and accumulate per-turn summaries without mutating the source session. Update the same progress part after each validated batch or recursively split range, reporting completed assistant turns out of the total.
20. If a non-empty response has malformed XML, create a fresh, non-forked repair session containing only the malformed response and strict XML template.
21. Send at most one repair request, parse it, and delete the repair session in cleanup.
22. Abort if the single repair attempt also fails.
23. Delete every batch, repair, and ephemeral session in cleanup.
24. Delete the progress message in cleanup.
25. Combine the validated per-turn summaries with the previous native checkpoint. If the combined text exceeds 12,000 characters, merge it in a fresh temporary rollup session and enforce the hard cap.
26. Arm a session-scoped native-writeback guard and call OpenCode's `session.summarize` endpoint with `auto = false`.
27. During only that native commit, replace the compaction prompt with a minimal `READY` request and remove the historical transcript from the provider request through `experimental.chat.messages.transform`.
28. Let OpenCode create its real user `CompactionPart` plus assistant message with `mode = "compaction"` and `summary = true`.
29. Replace the native assistant's provider text with the exact prepared Magic Compact checkpoint and delete any extra reasoning/text parts, leaving one summary body inside one native compaction block.
30. Clear the native-writeback guard in cleanup. Automatic preflight must ignore this guarded provider call.
31. Update current session metadata with `compactionCount`.
32. Measure the model-visible native checkpoint and retained tail rather than the complete durable transcript.
33. Update stats, inject an ignored stats notice, and show a success toast.

## Trim Flow (Experimental)

1. Parse `N`; default is `0`.
2. Build turns for the complete stored session, independent of compaction boundaries.
3. Preserve the `N` most recent assistant turns.
4. Load the source session and fork it as a backup.
5. Copy omission and stats caches to the backup.
6. Measure pre-trim tokens using provider tokens when available, otherwise local counting.
7. Apply the normal tool input and output trimming rules to older turns.
8. Mark processed completed tool states with `state.metadata.magicCompact.trimmed === true`.
9. Stop with a no-op toast if no tool states were processed.
10. Measure post-trim tokens and add the reduction to conversation stats.
11. Inject an ignored trim stats notice and show a success toast.

`/magic-trim` does not call an LLM, generate summaries, modify ordinary user or assistant content, insert a compaction boundary, or increment `compactionCount`.

Known issues: We do not check for noops.

## Backup Sessions

- Backup title: `[Backup] ${title} ${timestamp}`.
- The main session title stays unchanged on success.
- Backup metadata stores `sourceSessionId`, `compactedAt`, and `compactionCount`.
- The backup receives copies of omission and stats caches before mutation.
- Trim backups preserve the source session's current `compactionCount`.
- If compaction or trimming fails after backup creation, the backup is renamed back to the original title, the original session is deleted, and OpenCode selects the backup session.

## Turn Selection

- Messages are processed oldest-first.
- A turn is one or more adjacent user messages plus all following assistant messages before the next user group.
- Consecutive user/no-reply messages stay in the same turn.
- Boundary detection runs before ignoring a trailing assistantless turn.
- A trailing user-only turn does not count against `N`.
- Only turns with assistant messages are summarized.
- `N` preserves the most recent assistant turns in the current uncompacted range.
- For `/magic-trim`, `N` preserves tool I/O in the most recent assistant turns across the complete session.
- Trim selection does not use compaction boundaries.

## Recompaction

- New per-turn preparation starts after the latest OpenCode user `CompactionPart`; earlier raw turns are not summarized again.
- Legacy Magic Compact text boundaries remain recognized for migration.
- The previous native `summary = true` assistant text is merged with newly prepared summaries, then bounded to a single 12,000-character checkpoint.
- OpenCode retains the complete original transcript durably and projects only the latest native checkpoint plus its configured recent tail into model context.
- Reverting the native compaction block restores OpenCode's ordinary transcript/revert behavior; the backup session remains a second recovery path.

## Summarization

- Summaries are generated in an ephemeral session so the prompt and assistant stream stay out of the main session.
- The ephemeral session is a fork of the source session: the summarizer needs the full conversation in context to summarize assistant turns faithfully.
- Before summarization, the ephemeral fork applies the normal size thresholds to large completed tool I/O. The source and backup remain unchanged, and temporary omissions are not persisted because the fork is deleted.
- The plugin uses locally estimated tokens plus model limits to choose between one-shot and batched summarization. If metadata or estimation is unavailable, the provider remains the final authority.
- The model and prompt prefix must remain unchanged for cache reuse: the ephemeral request should use the same model, agent-controlled system prompt, and tool set as the source session.
- If the session record does not persist a model or agent selection, the plugin derives them from the latest eligible assistant message so budgeting and fresh batch sessions still use the active provider/model.
- The XML prompt is built from the OpenCode template.
- The XML prompt includes only the turns being summarized and, when needed, the next user turn as the boundary marker.
- User text in the prompt excludes synthetic and ignored text and is truncated to the first line or first 300 characters, whichever is shorter.
- The generated XML must contain one `<assistant>` summary for each summarized turn.
- Provider errors and empty responses abort without an XML retry.
- A malformed non-empty first response is corrected with at most one additional prompt in a fresh, non-forked repair session. The repair prompt contains only the malformed output and required template while preserving the source model, agent, variant, provider, and data boundary.
- Batch prompts contain a JSON projection of only their target turns from the already-trimmed ephemeral fork. Transcript content is explicitly treated as inert data.
- Batches preserve complete turn boundaries, run sequentially, and carry at most the two most recent summaries forward as context.
- Batch results are accumulated in memory and are not written into historical assistant messages.
- Context-overflow failures recursively bisect multi-turn batches. A single oversized turn aborts safely and recommends OpenCode's native `/compact`.
- The ignored progress notice moves through preparing, summarizing, XML repair, and applying phases. Batch progress advances only after XML for a complete turn range validates; active ranges reflect recursive splits. Progress-part update failures are non-fatal.
- A malformed repair response aborts compaction and follows normal recovery behavior.
- Per-turn summaries target at most 120 words unless critical state requires more.
- The final native checkpoint targets at most 1,200 words and has a 12,000-character hard cap.
- Oversized checkpoint rollups contain only prior/new summaries as inert JSON, run in fresh temporary sessions, and use the source model and variant.
- The exact prepared checkpoint replaces the provider's native summary text after OpenCode creates the native block.

## Native Writeback

- Native writeback is active only while `commitNativeCompaction` awaits `session.summarize` for one session ID.
- The guarded native provider request receives no source transcript and produces only disposable readiness text.
- The final assistant message is owned by OpenCode and has `summary === true`; Magic Compact updates only its parts after completion.
- All parts except one exact prepared summary text part are deleted from that native summary assistant.
- Ordinary native `/compact` calls are untouched because they have no Magic Compact writeback guard.

## Omission Cache

- Location: `${XDG_DATA_HOME:-~/.local/share}/opencode/storage/magic-compact/{sessionId}.json`.
- Cache format version is `1`.
- IDs are session-local sequential IDs: `omitted-001`, `omitted-002`, ...
- The current session cache is the active cache on success.
- The backup gets a cache copy before mutation.
- `/magic-trim` and legacy Magic Compact sessions use the session-local omission sequence. Native-block `/magic-compact` preserves the original transcript instead of copying it into omission storage.

## Omission Retrieval

- The plugin exposes `read_omitted_content` as an OpenCode plugin tool.
- The tool accepts one argument: `contentId`.
- The tool receives `context.sessionID` from OpenCode and reads that session's omission cache.
- If no matching cache entry exists, it returns a not-found message.

## Stats

- Stats are stored under `{dataDir}/magic-compact/stats/{sessionId}.json`.
- Stats cache format version is `1`.
- Each file stores `rootSessionId`, `sourceSessionId`, cumulative counters, and processed assistant message IDs.

### Tracked Metrics

- `totalTokensPruned` — cumulative tokens removed by compactions and trims.
- `cachedTokensSaved` — cumulative avoided cached-read tokens. On each completed assistant provider turn, add the current `totalTokensPruned`.
- `moneySaved` — computed at display time from `cachedTokensSaved` and the active model's cached-read price.

### Token Counting

- `countSessionTokens` counts persisted message part tokens locally plus estimated system prompt overhead.
- The system prompt estimate uses the first assistant message with provider usage and the first user message text.
- `getProviderTokens` scans backward for the latest positive provider-reported usage. Missing or zeroed usage, including failed context-overflow responses, is skipped; local counting is used only when no positive usage exists.

### Accounting

- Compaction: measure provider usage before compaction and count only the model-visible native checkpoint/retained tail afterward; add `max(0, beforeTokens - afterTokens)` to `totalTokensPruned`.
- Trim: count locally on the current session; add the reduction to `totalTokensPruned`. Trimming does not increment `compactionCount`.
- Real-time: a `message.updated` event hook watches for completed assistant messages; for each, add `totalTokensPruned` to `cachedTokensSaved`, deduplicated by assistant message ID.

### Pricing

- A static model-price mapping powers the money estimate.
- If the active model has no price entry, the money estimate is omitted and the notice says pricing is unavailable rather than implying that the model itself is unsupported.

### Notices

- After each compaction, OpenCode injects an ignored stats notice with compaction count, this-run savings, totals, and estimated money saved.
- After each trim, OpenCode injects an ignored trim stats notice with this-run savings, totals, and estimated money saved.
- `/magic-stats` injects the same cumulative summary on demand, or a no-stats message if no stats exist.

## Pruning

- Native-block `/magic-compact` does not delete or rewrite historical transcript messages; OpenCode's compaction projection excludes them from model context.
- `/magic-trim` applies only the tool rules below; it does not delete other user or assistant parts.
- `/magic-trim` marks processed completed tool states as trimmed and skips them on later trims.

## Tool Rules

The following state-level rules apply to `/magic-trim` and to disposable summary-fork shrinking. Native-block `/magic-compact` leaves the durable source tool parts intact.

- `write`: omit large `input.content` and cache it.
- `edit`: omit large `oldString` and `newString` together and cache once.
- `apply_patch`: omit large `input.patchText` and cache it.
- `bash`: cache long commands and visibly truncate to the first 512 characters plus `[REST OF COMMAND TRUNCATED]`.
- `read`: always cache and omit output.
- `task`: cache and omit output only above the higher task threshold.
- `todowrite`: preserve input and replace output with a success message, no cache.
- `question`: preserve input and output.
- `skill`: preserve input and replace output with a reload hint, no cache.
- Other completed tool outputs are cached and omitted when they exceed the default threshold.

## Error Handling

- Any LLM, XML, SDK, cache, stats, token counting, or pruning failure aborts the attempt.
- Cleanup deletes the ephemeral session and progress message when they exist.
- If a backup exists, it is promoted back.
- A failure toast is shown.
- The command hook throws so OpenCode does not continue sending the slash command to the LLM.
