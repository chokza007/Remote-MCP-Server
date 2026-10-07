import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  BrowserActionError,
  createBrowserService,
  createInMemoryBrowserLock,
  type BrowserService
} from "@remote-mcp/adapters";

const fixtureRoot = resolve("tests/fixtures/web");
const executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return new URL(`http://127.0.0.1:${address.port}`);
}

describe("managed browser automation", () => {
  let root: string;
  let server: Server;
  let origin: URL;
  const services: BrowserService[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-browser-"));
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      if (url.pathname === "/redirect") {
        response.writeHead(302, { location: "/" });
        response.end();
        return;
      }
      if (url.pathname === "/download") {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename=report.txt"
        });
        response.end("verified browser download\n");
        return;
      }
      if (url.pathname === "/slow") {
        setTimeout(() => { response.writeHead(200); response.end("slow"); }, 500);
        return;
      }
      const file = url.pathname === "/popup" ? "popup.html"
        : url.pathname === "/captcha" ? "captcha.html" : "index.html";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(await readFile(join(fixtureRoot, file)));
    });
    origin = await listen(server);
  });

  afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
  });

  function service(options: { authorize?: () => boolean; lock?: ReturnType<typeof createInMemoryBrowserLock> } = {}): BrowserService {
    const instance = createBrowserService({
      executablePath,
      profileRoot: join(root, "profiles"),
      artifactRoot: join(root, "artifacts"),
      lock: options.lock,
      authorize: options.authorize,
      allowedOrigins: [origin.origin]
    });
    services.push(instance);
    return instance;
  }

  test("uses semantic locators across redirects, popups, tabs, typing, and restart-safe profiles", async () => {
    const browser = service();
    const context = await browser.launch({ workspaceId: "workspace-a", headless: true });
    const tab = await browser.navigate({ contextId: context.contextId, url: new URL("/redirect", origin).href });
    expect(tab.url).toBe(new URL("/", origin).href);

    await browser.type({ tabId: tab.tabId, target: { label: "Display name" }, text: "สมชาย" });
    await browser.click({ tabId: tab.tabId, target: { role: "button", name: "Save profile" } });
    await browser.wait({ tabId: tab.tabId, target: { text: "Saved สมชาย" }, state: "visible" });
    await browser.click({ tabId: tab.tabId, target: { role: "button", name: "Open report" } });
    await browser.waitForTabs(context.contextId, 2, 5_000);
    expect((await browser.tabs(context.contextId)).map((entry) => entry.title)).toEqual(
      expect.arrayContaining(["Remote MCP Browser Fixture", "Report"])
    );

    const inspected = await browser.inspect(tab.tabId);
    expect(JSON.stringify(inspected)).not.toContain("BROWSER_SECRET_CANARY");
    expect(inspected.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "button", name: "Save profile" })
    ]));
  }, 30_000);

  test("verifies uploads, downloads, screenshots, and PDFs as hashed artifacts", async () => {
    const browser = service();
    const context = await browser.launch({ workspaceId: "workspace-artifacts", headless: true });
    const tab = await browser.navigate({ contextId: context.contextId, url: origin.href });
    const upload = join(root, "ตัวอย่าง.txt");
    await writeFile(upload, "upload body", "utf8");

    await browser.upload({ tabId: tab.tabId, target: { label: "Upload file" }, paths: [upload] });
    await browser.wait({ tabId: tab.tabId, target: { text: basename(upload) }, state: "visible" });
    const download = await browser.download({ tabId: tab.tabId, target: { role: "link", name: "Download report" } });
    const screenshot = await browser.screenshot({ tabId: tab.tabId, name: "fixture.png" });
    const pdf = await browser.pdf({ tabId: tab.tabId, name: "fixture.pdf" });

    for (const artifact of [download, screenshot, pdf]) {
      expect(artifact).toMatchObject({ size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(artifact.size).toBeGreaterThan(0);
    }
    expect(await readFile(download.path, "utf8")).toContain("verified browser download");
  }, 30_000);

  test("enforces profile locks, same-origin evaluation, timeout, and non-exporting state", async () => {
    const lock = createInMemoryBrowserLock();
    const first = service({ lock });
    const second = service({ lock });
    const context = await first.launch({ workspaceId: "shared", headless: true });
    await expect(second.launch({ workspaceId: "shared", headless: true })).rejects.toThrow(/lock|in use/i);
    const tab = await first.navigate({ contextId: context.contextId, url: origin.href });

    expect(await first.evaluate({ tabId: tab.tabId, expression: "document.title" })).toBe("Remote MCP Browser Fixture");
    await expect(first.evaluate({ tabId: tab.tabId, expression: "document.cookie" })).rejects.toThrow(/denied|policy/i);
    await expect(first.navigate({ contextId: context.contextId, url: "file:///C:/Windows/win.ini" })).rejects.toThrow(/scheme|policy/i);
    await expect(first.navigate({ contextId: context.contextId, url: new URL("/slow", origin).href, timeoutMs: 25 })).rejects.toMatchObject({ code: "timeout" });
    expect("cookies" in first || "exportCookies" in first || "storageState" in first).toBe(false);
  }, 30_000);

  test("requires attention for CAPTCHA/MFA and rechecks authorization before each action", async () => {
    let authorized = true;
    const browser = service({ authorize: () => authorized });
    const context = await browser.launch({ workspaceId: "revocable", headless: true });
    const tab = await browser.navigate({ contextId: context.contextId, url: origin.href });
    authorized = false;
    await expect(browser.click({ tabId: tab.tabId, target: { role: "button", name: "Save profile" } }))
      .rejects.toMatchObject({ code: "authorization_revoked" });

    authorized = true;
    await expect(browser.navigate({ contextId: context.contextId, url: new URL("/captcha", origin).href }))
      .rejects.toMatchObject({ code: "needs_attention" });
    expect(BrowserActionError).toBeDefined();
  }, 30_000);

  test.runIf(process.env.REMOTE_MCP_INTERACTIVE_BROWSER_TESTS === "1")(
    "launches and closes an interactive managed profile",
    async () => {
      const browser = service();
      const context = await browser.launch({ workspaceId: "interactive", headless: false });
      const tab = await browser.navigate({ contextId: context.contextId, url: origin.href });
      expect(tab.title).toBe("Remote MCP Browser Fixture");
      await browser.close(context.contextId);
    },
    30_000
  );
});
