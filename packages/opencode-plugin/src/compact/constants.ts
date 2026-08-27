export const POST_COMPACTION_NOTICE = `<post-compaction-notice>
A compaction operation has just been applied to all messages above. You may have to reread certain files to regain context. Certain historical tool input/output may have been omitted due to length. If the exact I/O of the tool call needs to be retrieved and functionality cannot be replicated via a new tool call, call the read_omitted_content tool with the appropriate Content ID to reread the tool I/O content.
</post-compaction-notice>`;

export const BOUNDARY_METADATA = {
  magicCompact: {
    boundary: true,
  },
};

// Note: OpenCode orders parts by ID. Use "-" to order first.

export function summaryPartID(messageID: string): string {
  return `prt_-magic_summary_${messageID}`;
}

export function boundaryPartID(messageID: string): string {
  return `prt_-magic_boundary_${messageID}`;
}

export function toolArchivePartID(messageID: string): string {
  return `prt_-magic_tool_archive_${messageID}`;
}

export function rollupArchivePartID(messageID: string): string {
  return `prt_-magic_rollup_archive_${messageID}`;
}

export function summaryMetadata(): Record<string, unknown> {
  return {
    magicCompact: {
      summary: true,
    },
  };
}

export function toolArchiveMetadata(): Record<string, unknown> {
  return {
    magicCompact: {
      toolArchive: true,
    },
  };
}

export function rollupSummaryMetadata(): Record<string, unknown> {
  return {
    magicCompact: {
      summary: true,
      rollup: true,
    },
  };
}

export function rollupArchiveMetadata(): Record<string, unknown> {
  return {
    magicCompact: {
      rollupArchive: true,
    },
  };
}

export function rollupArchiveNotice(
  summaryCount: number,
  length: number,
  contentID: string,
): string {
  return `<historical-summary-omission-notice>
${summaryCount} detailed historical summary record(s) were replaced by the adjacent bounded rollup. Their exact text and archive pointers remain locally retrievable.

Archived Length: ${length} characters
Content ID: ${contentID}
</historical-summary-omission-notice>`;
}

export function toolArchiveNotice(
  toolCount: number,
  length: number,
  contentID: string,
): string {
  return `<tool-transcript-omission-notice>
${toolCount} historical tool call(s) were removed from active context after their findings were summarized. The exact serialized tool transcript remains locally retrievable.

Archived Length: ${length} characters
Content ID: ${contentID}
</tool-transcript-omission-notice>`;
}

export function outputOmissionNotice(
  description: string,
  length: number,
  contentID: string,
): string {
  return `<tool-output-omission-notice>
${description}

Output Length: ${length} characters
Content ID: ${contentID}
</tool-output-omission-notice>`;
}

export function inputOmissionNotice(
  description: string,
  length: number,
  contentID: string,
): string {
  return `<tool-input-omission-notice>
${description}

Omitted Length: ${length} characters
Content ID: ${contentID}
</tool-input-omission-notice>`;
}
