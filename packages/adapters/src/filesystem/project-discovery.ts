import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export type ProjectGuidanceKind =
  | "readme"
  | "overview"
  | "checkpoint"
  | "rules"
  | "workflow";

export interface ProjectGuidanceReference {
  readonly kind: ProjectGuidanceKind;
  readonly path: string;
  readonly relativePath: string;
  readonly projectRoot: string;
}

const excludedDirectories = new Set([".git", "node_modules", "dist", "build", "coverage"]);

function guidanceKind(relativePath: string): ProjectGuidanceKind | null {
  const normalized = relativePath.replaceAll("/", "\\");
  const name = normalized.split("\\").at(-1)?.toLowerCase() ?? "";
  if (name === "readme.md") return "readme";
  if (name === "project_overview.md") return "overview";
  if (name === "work_checkpoint.md") return "checkpoint";
  if (["agents.md", "claude.md", "rules.md", ".cursorrules"].includes(name)) return "rules";
  if (name.includes("workflow") || normalized.toLowerCase().includes(".github\\workflows\\")) {
    return "workflow";
  }
  return null;
}

export async function discoverProjectGuidance(
  projectRootValue: string
): Promise<readonly ProjectGuidanceReference[]> {
  const projectRoot = resolve(projectRootValue);
  if (!(await lstat(projectRoot)).isDirectory()) throw new Error("Project root must be a directory");
  const found: ProjectGuidanceReference[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 8) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) await visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(projectRoot, fullPath);
      const kind = guidanceKind(relativePath);
      if (kind) found.push({ kind, path: fullPath, relativePath, projectRoot });
    }
  }

  await visit(projectRoot, 0);
  return found.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}
