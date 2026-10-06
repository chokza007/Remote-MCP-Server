import type { PatchEdit } from "./contracts.js";

function occurrences(value: string, search: string): number {
  if (search.length === 0) throw new Error("Patch search text must not be empty");
  let count = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(search, cursor)) !== -1) {
    count += 1;
    cursor += search.length;
  }
  return count;
}

export function applyExactTextEdits(value: string, edits: readonly PatchEdit[]): string {
  if (edits.length === 0) throw new Error("Patch must contain at least one edit");
  let output = value;
  for (const edit of edits) {
    const count = occurrences(output, edit.search);
    const expected = edit.expectedOccurrences ?? 1;
    if (count !== expected) {
      throw new Error(`Patch expected ${expected} occurrence(s) but found ${count}`);
    }
    output = output.split(edit.search).join(edit.replace);
  }
  return output;
}
