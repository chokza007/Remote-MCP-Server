import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright-core";

import { BrowserDownloadManager, type BrowserArtifact } from "./download-manager.js";
import { BrowserPolicy, BrowserPolicyError } from "./browser-policy.js";
import {
  BrowserProfileManager,
  type BrowserProfileLease,
  type BrowserProfileLock
} from "./profile-manager.js";

export type BrowserActionErrorCode =
  | "not_found"
  | "ambiguous_target"
  | "timeout"
  | "needs_attention"
  | "authorization_revoked"
  | "policy_denied"
  | "browser_error";

export class BrowserActionError extends Error {
  public readonly code: BrowserActionErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(code: BrowserActionErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "BrowserActionError";
    this.code = code;
    this.details = details;
  }
}

export interface BrowserTarget {
  readonly role?: string;
  readonly name?: string;
  readonly label?: string;
  readonly text?: string;
  readonly testId?: string;
  readonly css?: string;
}

export interface BrowserContextInfo {
  readonly contextId: string;
  readonly workspaceId: string;
  readonly profileKey: string;
  readonly headless: boolean;
}

export interface BrowserTabInfo {
  readonly tabId: string;
  readonly contextId: string;
  readonly url: string;
  readonly title: string;
}

export interface BrowserInspectionElement {
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly disabled: boolean;
  readonly secret: boolean;
}

export interface BrowserInspection {
  readonly tab: BrowserTabInfo;
  readonly elements: readonly BrowserInspectionElement[];
}

export interface BrowserServiceOptions {
  readonly profileRoot: string;
  readonly artifactRoot: string;
  readonly executablePath?: string;
  readonly lock?: BrowserProfileLock;
  readonly authorize?: () => boolean | Promise<boolean>;
  readonly allowedOrigins?: readonly string[];
  readonly defaultTimeoutMs?: number;
}

export function discoverBrowserExecutable(): string | undefined {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
    ...(localAppData === undefined ? [] : [
      `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`
    ])
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

interface ManagedContext {
  readonly info: BrowserContextInfo;
  readonly context: BrowserContext;
  readonly lease: BrowserProfileLease;
}

interface ManagedTab {
  readonly tabId: string;
  readonly contextId: string;
  readonly page: Page;
}

function inferRole(element: { tag: string; role: string | null; type: string | null }): string {
  if (element.role) return element.role;
  if (element.tag === "button") return "button";
  if (element.tag === "a") return "link";
  if (element.tag === "textarea") return "textbox";
  if (element.tag === "input") {
    if (element.type === "checkbox") return "checkbox";
    if (element.type === "radio") return "radio";
    if (element.type === "submit" || element.type === "button") return "button";
    if (element.type === "file") return "button";
    return "textbox";
  }
  return element.tag;
}

function mappedError(error: unknown): BrowserActionError {
  if (error instanceof BrowserActionError) return error;
  if (error instanceof BrowserPolicyError) {
    return new BrowserActionError(
      error.code === "needs_attention" ? "needs_attention" : "policy_denied",
      error.message
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/iu.test(message)) return new BrowserActionError("timeout", message);
  return new BrowserActionError("browser_error", message);
}

export class BrowserService {
  readonly #profiles: BrowserProfileManager;
  readonly #artifacts: BrowserDownloadManager;
  readonly #policy: BrowserPolicy;
  readonly #executablePath: string | undefined;
  readonly #authorizeCallback: (() => boolean | Promise<boolean>) | undefined;
  readonly #timeoutMs: number;
  readonly #contexts = new Map<string, ManagedContext>();
  readonly #tabs = new Map<string, ManagedTab>();
  readonly #pageIds = new WeakMap<Page, string>();

  public constructor(options: BrowserServiceOptions) {
    this.#profiles = new BrowserProfileManager({
      root: options.profileRoot,
      ...(options.lock === undefined ? {} : { lock: options.lock })
    });
    this.#artifacts = new BrowserDownloadManager(options.artifactRoot);
    this.#policy = new BrowserPolicy({
      ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins })
    });
    this.#executablePath = options.executablePath ?? discoverBrowserExecutable();
    this.#authorizeCallback = options.authorize;
    this.#timeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  public async launch(input: { readonly workspaceId: string; readonly headless?: boolean }): Promise<BrowserContextInfo> {
    await this.#authorize();
    const lease = await this.#profiles.acquire(input.workspaceId);
    const contextId = randomUUID();
    try {
      const context = await chromium.launchPersistentContext(lease.path, {
        ...(this.#executablePath === undefined ? {} : { executablePath: this.#executablePath }),
        headless: input.headless !== false,
        acceptDownloads: true,
        colorScheme: "dark",
        args: ["--disable-background-networking", "--no-first-run", "--no-default-browser-check"]
      });
      const info: BrowserContextInfo = {
        contextId,
        workspaceId: input.workspaceId,
        profileKey: lease.profileKey,
        headless: input.headless !== false
      };
      this.#contexts.set(contextId, { info, context, lease });
      context.on("page", (page) => this.#registerPage(contextId, page));
      for (const page of context.pages()) this.#registerPage(contextId, page);
      return info;
    } catch (error) {
      await lease.release();
      throw mappedError(error);
    }
  }

  public async close(contextId: string): Promise<void> {
    const managed = this.#requireContext(contextId);
    this.#contexts.delete(contextId);
    for (const [tabId, tab] of this.#tabs) if (tab.contextId === contextId) this.#tabs.delete(tabId);
    try {
      await managed.context.close();
    } finally {
      await managed.lease.release();
    }
  }

  public contexts(): readonly BrowserContextInfo[] {
    return [...this.#contexts.values()].map(({ info }) => info);
  }

  public async tabs(contextId: string): Promise<readonly BrowserTabInfo[]> {
    this.#requireContext(contextId);
    const tabs = [...this.#tabs.values()].filter((entry) => entry.contextId === contextId && !entry.page.isClosed());
    return Promise.all(tabs.map((entry) => this.#tabInfo(entry)));
  }

  public async waitForTabs(contextId: string, count: number, timeoutMs = this.#timeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((await this.tabs(contextId)).length < count) {
      if (Date.now() >= deadline) throw new BrowserActionError("timeout", `Timed out waiting for ${count} tabs`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }

  public async navigate(input: {
    readonly contextId: string;
    readonly tabId?: string;
    readonly url: string;
    readonly timeoutMs?: number;
  }): Promise<BrowserTabInfo> {
    await this.#authorize();
    const requested = this.#policy.validateUrl(input.url);
    const managed = this.#requireContext(input.contextId);
    const tab = input.tabId === undefined
      ? this.#preferredTab(managed)
      : this.#requireTab(input.tabId, input.contextId);
    try {
      await tab.page.goto(requested.href, {
        waitUntil: "domcontentloaded",
        timeout: input.timeoutMs ?? this.#timeoutMs
      });
      this.#policy.validateUrl(tab.page.url());
      await this.#detectAttention(tab.page);
      return this.#tabInfo(tab);
    } catch (error) {
      throw mappedError(error);
    }
  }

  public async inspect(tabId: string): Promise<BrowserInspection> {
    await this.#authorize();
    const tab = this.#requireTab(tabId);
    await this.#detectAttention(tab.page);
    const raw = await tab.page.locator("body *").evaluateAll((nodes) => nodes.slice(0, 5_000).map((node) => {
      const element = node as unknown as {
        readonly tagName: string;
        readonly innerText?: string;
        readonly disabled?: boolean;
        readonly labels?: ArrayLike<{ readonly textContent: string | null }>;
        readonly type?: string;
        getAttribute(name: string): string | null;
      };
      const tag = element.tagName.toLowerCase();
      const type = tag === "input" ? (element.type ?? "").toLowerCase() : null;
      const aria = element.getAttribute("aria-label")?.trim();
      const labelledBy = element.getAttribute("aria-labelledby");
      const label = tag === "input" && element.labels?.length ? element.labels[0]?.textContent?.trim() : undefined;
      const browserDocument = (globalThis as unknown as {
        readonly document: { getElementById(id: string): { readonly textContent: string | null } | null };
      }).document;
      const name = aria || label || (labelledBy ? browserDocument.getElementById(labelledBy)?.textContent?.trim() : undefined)
        || element.innerText?.trim().slice(0, 500) || "";
      return {
        tag,
        type,
        role: element.getAttribute("role"),
        name,
        disabled: Boolean(element.disabled),
        secret: type === "password"
      };
    }));
    return {
      tab: await this.#tabInfo(tab),
      elements: raw.map((entry) => ({
        role: inferRole(entry),
        name: entry.name,
        tag: entry.tag,
        disabled: entry.disabled,
        secret: entry.secret
      }))
    };
  }

  public async click(input: { readonly tabId: string; readonly target: BrowserTarget; readonly timeoutMs?: number }): Promise<{
    readonly status: "completed";
    readonly verified: true;
    readonly url: string;
  }> {
    await this.#authorize();
    const tab = this.#requireTab(input.tabId);
    const locator = await this.#target(tab.page, input.target);
    try {
      await locator.click({ timeout: input.timeoutMs ?? this.#timeoutMs });
      await this.#authorize();
      await this.#detectAttention(tab.page);
      return { status: "completed", verified: true, url: tab.page.url() };
    } catch (error) {
      throw mappedError(error);
    }
  }

  public async type(input: {
    readonly tabId: string;
    readonly target: BrowserTarget;
    readonly text: string;
    readonly timeoutMs?: number;
  }): Promise<{ readonly status: "completed"; readonly verified: true }> {
    await this.#authorize();
    const tab = this.#requireTab(input.tabId);
    const locator = await this.#target(tab.page, input.target);
    try {
      await locator.fill(input.text, { timeout: input.timeoutMs ?? this.#timeoutMs });
      await this.#authorize();
      return { status: "completed", verified: true };
    } catch (error) {
      throw mappedError(error);
    }
  }

  public async upload(input: {
    readonly tabId: string;
    readonly target: BrowserTarget;
    readonly paths: readonly string[];
    readonly timeoutMs?: number;
  }): Promise<{ readonly status: "completed"; readonly files: number }> {
    await this.#authorize();
    const tab = this.#requireTab(input.tabId);
    const locator = await this.#target(tab.page, input.target);
    await locator.setInputFiles(input.paths.map((path) => resolve(path)), { timeout: input.timeoutMs ?? this.#timeoutMs });
    await this.#authorize();
    return { status: "completed", files: input.paths.length };
  }

  public async download(input: {
    readonly tabId: string;
    readonly target: BrowserTarget;
    readonly timeoutMs?: number;
  }): Promise<BrowserArtifact> {
    await this.#authorize();
    const tab = this.#requireTab(input.tabId);
    const locator = await this.#target(tab.page, input.target);
    try {
      const [download] = await Promise.all([
        tab.page.waitForEvent("download", { timeout: input.timeoutMs ?? this.#timeoutMs }),
        locator.click({ timeout: input.timeoutMs ?? this.#timeoutMs })
      ]);
      await this.#authorize();
      return await this.#artifacts.saveDownload(download);
    } catch (error) {
      throw mappedError(error);
    }
  }

  public async wait(input: {
    readonly tabId: string;
    readonly target: BrowserTarget;
    readonly state: "attached" | "detached" | "visible" | "hidden";
    readonly timeoutMs?: number;
  }): Promise<{ readonly status: "completed"; readonly state: string }> {
    await this.#authorize();
    const tab = this.#requireTab(input.tabId);
    const locator = this.#locator(tab.page, input.target);
    try {
      await locator.waitFor({ state: input.state, timeout: input.timeoutMs ?? this.#timeoutMs });
      return { status: "completed", state: input.state };
    } catch (error) {
      throw mappedError(error);
    }
  }

  public async screenshot(input: { readonly tabId: string; readonly name?: string }): Promise<BrowserArtifact> {
    await this.#authorize();
    const tab = this.#requireTab(input.tabId);
    return this.#artifacts.screenshot(tab.page, input.name ?? `browser-${Date.now()}.png`);
  }

  public async pdf(input: { readonly tabId: string; readonly name?: string }): Promise<BrowserArtifact> {
    await this.#authorize();
    const tab = this.#requireTab(input.tabId);
    return this.#artifacts.pdf(tab.page, input.name ?? `browser-${Date.now()}.pdf`);
  }

  public async evaluate(input: { readonly tabId: string; readonly expression: string }): Promise<unknown> {
    await this.#authorize();
    const tab = this.#requireTab(input.tabId);
    this.#policy.validateEvaluation(input.expression, tab.page.url());
    const result = await tab.page.evaluate(input.expression);
    await this.#authorize();
    return result;
  }

  public async dispose(): Promise<void> {
    await Promise.allSettled([...this.#contexts.keys()].map((contextId) => this.close(contextId)));
  }

  async #authorize(): Promise<void> {
    if (this.#authorizeCallback !== undefined && !(await this.#authorizeCallback())) {
      throw new BrowserActionError("authorization_revoked", "Browser authorization was revoked");
    }
  }

  #registerPage(contextId: string, page: Page): ManagedTab {
    const existingId = this.#pageIds.get(page);
    if (existingId !== undefined) return this.#tabs.get(existingId)!;
    const tab: ManagedTab = { tabId: randomUUID(), contextId, page };
    this.#pageIds.set(page, tab.tabId);
    this.#tabs.set(tab.tabId, tab);
    page.once("close", () => this.#tabs.delete(tab.tabId));
    return tab;
  }

  #preferredTab(context: ManagedContext): ManagedTab {
    const existing = [...this.#tabs.values()].find((entry) => entry.contextId === context.info.contextId && !entry.page.isClosed());
    return existing ?? this.#registerPage(context.info.contextId, context.context.pages()[0] ?? (() => {
      throw new BrowserActionError("browser_error", "Browser context has no page");
    })());
  }

  #requireContext(contextId: string): ManagedContext {
    const context = this.#contexts.get(contextId);
    if (!context) throw new BrowserActionError("not_found", `Browser context was not found: ${contextId}`);
    return context;
  }

  #requireTab(tabId: string, contextId?: string): ManagedTab {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.page.isClosed() || (contextId !== undefined && tab.contextId !== contextId)) {
      throw new BrowserActionError("not_found", `Browser tab was not found: ${tabId}`);
    }
    return tab;
  }

  async #tabInfo(tab: ManagedTab): Promise<BrowserTabInfo> {
    return { tabId: tab.tabId, contextId: tab.contextId, url: tab.page.url(), title: await tab.page.title() };
  }

  #locator(page: Page, target: BrowserTarget): Locator {
    if (target.role !== undefined) {
      return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
        ...(target.name === undefined ? {} : { name: target.name }),
        exact: true
      });
    }
    if (target.label !== undefined) return page.getByLabel(target.label, { exact: true });
    if (target.text !== undefined) return page.getByText(target.text, { exact: true });
    if (target.testId !== undefined) return page.getByTestId(target.testId);
    if (target.css !== undefined) return page.locator(target.css);
    throw new BrowserActionError("not_found", "A browser target selector is required");
  }

  async #target(page: Page, target: BrowserTarget): Promise<Locator> {
    const locator = this.#locator(page, target);
    const count = await locator.count();
    if (count === 0) throw new BrowserActionError("not_found", "Browser target was not found");
    if (count > 1) throw new BrowserActionError("ambiguous_target", `Browser target matched ${count} elements`);
    return locator;
  }

  async #detectAttention(page: Page): Promise<void> {
    const challenge = page.locator([
      ".g-recaptcha",
      "iframe[src*='captcha' i]",
      "[data-sitekey]",
      "input[autocomplete='one-time-code']",
      "input[name*='otp' i]",
      "input[name*='mfa' i]"
    ].join(","));
    const challengeCount = await challenge.count();
    const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 100_000);
    if (challengeCount > 0 || /(?:captcha|verify you are human|multi[- ]factor|authentication code|one[- ]time code)/iu.test(text)) {
      throw new BrowserActionError("needs_attention", "CAPTCHA or MFA requires direct user attention", {
        reason: "captcha_or_mfa",
        url: page.url()
      });
    }
  }
}

export function createBrowserService(options: BrowserServiceOptions): BrowserService {
  return new BrowserService(options);
}
