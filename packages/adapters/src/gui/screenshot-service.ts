import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import type { GuiBackend } from "./uia-client.js";
import type { GuiCaptureResult, GuiEvidence, WindowInfo } from "./window-model.js";

export interface ScreenshotServiceOptions {
  readonly backend: GuiBackend;
  readonly artifactRoot: string;
}

export class ScreenshotService {
  readonly #backend: GuiBackend;
  readonly #root: string;

  public constructor(options: ScreenshotServiceOptions) {
    this.#backend = options.backend;
    this.#root = resolve(options.artifactRoot);
  }

  public async capture(window: WindowInfo | undefined, name: string, timeoutMs: number): Promise<GuiCaptureResult> {
    await mkdir(this.#root, { recursive: true });
    const safeName = basename(name).replace(/[^\p{L}\p{N}._-]/gu, "_");
    const path = resolve(this.#root, safeName.toLowerCase().endsWith(".png") ? safeName : `${safeName}.png`);
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new Error("Screenshot path escaped the artifact root");
    }
    const response = await this.#backend.execute({
      operation: "capture",
      payload: { path, ...(window === undefined ? {} : { window }) },
      timeoutMs
    });
    if (!response.ok) throw new Error(response.message ?? response.code ?? "Screenshot capture failed");
    const bytes = await readFile(path);
    const evidence: GuiEvidence = {
      kind: response.evidence?.kind ?? "screenshot",
      ...response.evidence,
      verified: true,
      path
    };
    return {
      status: "completed",
      path,
      mediaType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      evidence
    };
  }
}

export function createScreenshotService(options: ScreenshotServiceOptions): ScreenshotService {
  return new ScreenshotService(options);
}
