import { readFile } from "node:fs/promises";

import { unzipSync } from "fflate";

export interface ContentMatch {
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}

export interface ArchiveMemberMatch {
  readonly memberPath: string;
  readonly size: number;
  readonly matches: readonly ContentMatch[];
}

export interface TextExtraction {
  readonly binary: boolean;
  readonly matches: readonly ContentMatch[];
}

function isBinary(value: Uint8Array): boolean {
  const sample = value.subarray(0, Math.min(value.byteLength, 8_192));
  return sample.some((byte) => byte === 0);
}

export function matchText(text: string, matcher: RegExp): readonly ContentMatch[] {
  const matches: ContentMatch[] = [];
  const lines = text.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    matcher.lastIndex = 0;
    const match = matcher.exec(line);
    if (match?.index !== undefined) {
      matches.push({
        line: lineIndex + 1,
        column: match.index + 1,
        excerpt: line.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80)
      });
    }
  }
  return matches;
}

export async function extractFileText(path: string, matcher: RegExp): Promise<TextExtraction> {
  const data = await readFile(path);
  if (isBinary(data)) return { binary: true, matches: [] };
  return { binary: false, matches: matchText(data.toString("utf8"), matcher) };
}

export async function extractZipMembers(
  path: string,
  matcher: RegExp,
  remainingBytes: number
): Promise<readonly ArchiveMemberMatch[]> {
  const archive = await readFile(path);
  const files = unzipSync(archive, { filter: (entry) => !entry.name.endsWith("/") });
  const output: ArchiveMemberMatch[] = [];
  let expandedBytes = 0;
  for (const memberPath of Object.keys(files).sort((left, right) => left.localeCompare(right, "en"))) {
    const data = files[memberPath]!;
    expandedBytes += data.byteLength;
    if (expandedBytes > remainingBytes) throw new Error("Archive expansion exceeds the search byte limit");
    if (isBinary(data)) continue;
    const matches = matchText(Buffer.from(data).toString("utf8"), matcher);
    if (matches.length > 0) output.push({ memberPath, size: data.byteLength, matches });
  }
  return output;
}
