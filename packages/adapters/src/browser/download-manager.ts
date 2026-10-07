import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import type { Download, Page } from "playwright-core";

export interface BrowserArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly size: number;
}

export class BrowserDownloadManager {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = resolve(root);
  }

  public async prepare(name: string): Promise<string> {
    await mkdir(this.#root, { recursive: true });
    const safe = basename(name).replace(/[^\p{L}\p{N}._-]/gu, "_");
    const path = resolve(this.#root, safe || "artifact.bin");
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new Error("Browser artifact path escaped its root");
    }
    return path;
  }

  public async finish(path: string, mediaType: string): Promise<BrowserArtifact> {
    const bytes = await readFile(path);
    return {
      path,
      mediaType,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length
    };
  }

  public async saveDownload(download: Download): Promise<BrowserArtifact> {
    const failure = await download.failure();
    if (failure) throw new Error(`Browser download failed: ${failure}`);
    const path = await this.prepare(download.suggestedFilename());
    await download.saveAs(path);
    return this.finish(path, "application/octet-stream");
  }

  public async screenshot(page: Page, name: string): Promise<BrowserArtifact> {
    const path = await this.prepare(name.toLowerCase().endsWith(".png") ? name : `${name}.png`);
    await page.screenshot({ path, fullPage: true, type: "png" });
    return this.finish(path, "image/png");
  }

  public async pdf(page: Page, name: string): Promise<BrowserArtifact> {
    const path = await this.prepare(name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`);
    await page.pdf({ path, printBackground: true, preferCSSPageSize: true });
    return this.finish(path, "application/pdf");
  }
}
