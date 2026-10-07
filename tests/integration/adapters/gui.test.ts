import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  GuiActionError,
  createGuiService,
  type GuiBackend,
  type GuiBackendRequest,
  type GuiBackendResponse,
  type UiElement,
  type WindowInfo
} from "@remote-mcp/adapters";

const window: WindowInfo = {
  handle: "0x1234",
  processId: 42,
  title: "Remote MCP GUI Fixture",
  className: "WindowsForms10.Window",
  bounds: { x: 320, y: 180, width: 900, height: 600 },
  dpi: 144,
  focused: true,
  modal: false
};

const elements: UiElement[] = [
  {
    runtimeId: "42.1",
    windowHandle: window.handle,
    automationId: "primary-save",
    name: "Save",
    controlType: "Button",
    bounds: { x: 350, y: 230, width: 100, height: 32 },
    enabled: true,
    focused: false,
    password: false,
    patterns: ["Invoke"]
  },
  {
    runtimeId: "42.2",
    windowHandle: window.handle,
    automationId: "secondary-save",
    name: "Save",
    controlType: "Button",
    bounds: { x: 480, y: 230, width: 100, height: 32 },
    enabled: true,
    focused: false,
    password: false,
    patterns: ["Invoke"]
  },
  {
    runtimeId: "42.3",
    windowHandle: window.handle,
    automationId: "secret-input",
    name: "Secret",
    controlType: "Edit",
    bounds: { x: 350, y: 280, width: 300, height: 32 },
    enabled: true,
    focused: false,
    password: true,
    patterns: ["Value"]
  }
];

class FixtureBackend implements GuiBackend {
  public secureDesktop = false;
  public stealFocus = false;
  public staleOnce = false;
  public delayMs = 0;
  public currentWindow: WindowInfo = window;
  public readonly requests: GuiBackendRequest[] = [];
  readonly #root: string;

  public constructor(root: string) {
    this.#root = root;
  }

  public async execute(request: GuiBackendRequest): Promise<GuiBackendResponse> {
    this.requests.push(request);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (request.operation === "desktop_state") {
      return {
        ok: true,
        secureDesktop: this.secureDesktop,
        desktop: { name: this.secureDesktop ? "Winlogon" : "Default", interactive: !this.secureDesktop }
      };
    }
    if (request.operation === "windows") return { ok: true, windows: [this.currentWindow] };
    if (request.operation === "inspect") return { ok: true, window: this.currentWindow, elements };
    if (this.staleOnce) {
      this.staleOnce = false;
      return { ok: false, code: "stale_element", message: "Element was replaced" };
    }
    if (request.operation === "capture") {
      const path = String(request.payload.path);
      await import("node:fs/promises").then(({ writeFile }) =>
        writeFile(path, Buffer.from("89504e470d0a1a0a", "hex"))
      );
      return { ok: true, evidence: { kind: "screenshot", path, windowHandle: window.handle } };
    }
    const target = request.payload.target as UiElement | undefined;
    return {
      ok: true,
      evidence: {
        kind: "observed_state",
        operation: request.operation,
        windowHandle: window.handle,
        runtimeId: target?.runtimeId,
        focusedWindowHandle: this.stealFocus ? "0x9999" : window.handle,
        value: target?.password ? "[REDACTED]" : request.payload.text,
        verified: !this.stealFocus
      }
    };
  }
}

describe("verified Windows GUI automation", () => {
  let root: string;
  const fixtureProcesses: ChildProcess[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-gui-"));
  });

  afterEach(async () => {
    for (const child of fixtureProcesses.splice(0)) child.kill();
    await rm(root, { recursive: true, force: true });
  });

  test("uses a semantic selector for duplicate labels and survives a stale element", async () => {
    const backend = new FixtureBackend(root);
    backend.staleOnce = true;
    const gui = createGuiService({ backend, artifactRoot: root });

    const result = await gui.invoke({
      window: { title: "Remote MCP GUI Fixture" },
      target: { automationId: "secondary-save", name: "Save", controlType: "Button" }
    });

    expect(result).toMatchObject({
      status: "completed",
      strategy: "uia_semantic",
      attempts: 2,
      evidence: { verified: true, runtimeId: "42.2" }
    });
    expect(backend.requests.filter((entry) => entry.operation === "inspect")).toHaveLength(2);
    expect(backend.requests.some((entry) => "absoluteX" in entry.payload)).toBe(false);
  });

  test("re-resolves positions after DPI/window movement and labels coordinate fallback", async () => {
    const backend = new FixtureBackend(root);
    const gui = createGuiService({ backend, artifactRoot: root });

    const semantic = await gui.click({
      window: { handle: window.handle },
      target: { automationId: "primary-save" }
    });
    backend.currentWindow = {
      ...window,
      bounds: { x: 600, y: 300, width: 1_200, height: 800 },
      dpi: 192
    };
    const fallback = await gui.click({
      window: { handle: window.handle },
      target: { coordinates: { x: 0.5, y: 0.5, relativeTo: "window" } },
      allowCoordinateFallback: true
    });

    expect(semantic.strategy).toBe("uia_semantic");
    expect(fallback).toMatchObject({ strategy: "window_relative_coordinates", status: "completed" });
    expect(backend.requests.at(-1)?.payload).toMatchObject({ point: { x: 1_200, y: 700 } });
  });

  test("redacts secret-field Unicode typing and detects focus theft", async () => {
    const backend = new FixtureBackend(root);
    const gui = createGuiService({ backend, artifactRoot: root });
    const secret = "รหัสผ่าน-秘密-🔐";

    const result = await gui.type({
      window: { handle: window.handle },
      target: { automationId: "secret-input" },
      text: secret
    });
    expect(result.evidence).toMatchObject({ value: "[REDACTED]", verified: true });
    expect(JSON.stringify(result)).not.toContain(secret);

    backend.stealFocus = true;
    await expect(
      gui.keys({ window: { handle: window.handle }, keys: ["CTRL", "S"] })
    ).rejects.toMatchObject({ code: "postcondition_failed" });
  });

  test("returns needs_attention for secure desktop and supports verified modal targeting", async () => {
    const backend = new FixtureBackend(root);
    const gui = createGuiService({ backend, artifactRoot: root });
    backend.secureDesktop = true;

    await expect(gui.focus({ handle: window.handle })).rejects.toMatchObject({
      code: "needs_attention",
      details: { reason: "secure_desktop" }
    });

    backend.secureDesktop = false;
    const result = await gui.wait({
      window: { title: "Remote MCP GUI Fixture", modal: false },
      condition: "exists",
      timeoutMs: 250
    });
    expect(result).toMatchObject({ status: "completed", evidence: { verified: true } });
  });

  test("times out deterministically and emits a hashed screenshot artifact", async () => {
    const backend = new FixtureBackend(root);
    const gui = createGuiService({ backend, artifactRoot: root });

    await expect(
      gui.wait({ window: { title: "Missing" }, condition: "exists", timeoutMs: 30, pollMs: 5 })
    ).rejects.toBeInstanceOf(GuiActionError);

    const capture = await gui.capture({ window: { handle: window.handle }, name: "fixture.png" });
    expect(capture).toMatchObject({ status: "completed", mediaType: "image/png", size: 8 });
    expect(capture.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(capture.path)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
  });

  test.runIf(process.platform === "win32")("reports the real Windows input desktop through the PowerShell helper", async () => {
    const gui = createGuiService({
      modulePath: resolve("helpers/powershell/RemoteMcp.UIAutomation.psm1"),
      artifactRoot: root
    });

    expect(await gui.desktops(10_000)).toEqual([
      expect.objectContaining({ name: expect.any(String), interactive: expect.any(Boolean) })
    ]);
  });

  test("keeps the visible GUI fixture fully dark, including its custom title bar", async () => {
    const source = await readFile(resolve("tests/fixtures/gui-app/RemoteMcp.GuiFixture.ps1"), "utf8");
    expect(source).toContain('WindowStyle="None"');
    expect(source).toContain('Background="#090D14"');
    expect(source).toContain('Background="#111823"');
    expect(source).not.toMatch(/Background\s*=\s*"(?:White|#FFF(?:FFF)?)"/iu);
  });

  test.runIf(process.platform === "win32")("drives the disposable WinForms fixture by automation identity", async () => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File",
      resolve("tests/fixtures/gui-app/RemoteMcp.GuiFixture.ps1")
    ], { windowsHide: false, stdio: "ignore" });
    fixtureProcesses.push(child);
    const gui = createGuiService({
      modulePath: resolve("helpers/powershell/RemoteMcp.UIAutomation.psm1"),
      artifactRoot: root
    });
    await gui.wait({
      window: { title: "Remote MCP GUI Fixture" },
      condition: "exists",
      timeoutMs: 15_000,
      pollMs: 100
    });

    const inspected = await gui.inspect({ window: { title: "Remote MCP GUI Fixture" }, timeoutMs: 10_000 });
    expect(inspected.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ automationId: "primary-save", name: "Save" }),
      expect.objectContaining({ automationId: "secondary-save", name: "Save" }),
      expect.objectContaining({ automationId: "secret-input", password: true })
    ]));
    expect(await gui.invoke({
      window: { handle: inspected.window.handle },
      target: { automationId: "secondary-save" },
      timeoutMs: 10_000
    })).toMatchObject({ status: "completed", strategy: "uia_semantic", evidence: { verified: true } });
  }, 30_000);
});
