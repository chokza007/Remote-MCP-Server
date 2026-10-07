import { resolve } from "node:path";

import { createPowerShellUiaClient, type GuiBackend, type GuiBackendResponse } from "./uia-client.js";
import { ScreenshotService } from "./screenshot-service.js";
import {
  coordinatePoint,
  GuiTargetingError,
  selectElement,
  selectWindow
} from "./targeting.js";
import type {
  DesktopInfo,
  GuiActionResult,
  GuiCaptureResult,
  GuiEvidence,
  GuiTargetSelector,
  GuiTargetStrategy,
  UiElement,
  WindowInfo,
  WindowSelector
} from "./window-model.js";

export type GuiActionErrorCode =
  | "needs_attention"
  | "not_found"
  | "ambiguous_target"
  | "coordinate_fallback_denied"
  | "stale_element"
  | "timeout"
  | "postcondition_failed"
  | "backend_error";

export class GuiActionError extends Error {
  public readonly code: GuiActionErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(code: GuiActionErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "GuiActionError";
    this.code = code;
    this.details = details;
  }
}

export interface GuiServiceOptions {
  readonly backend?: GuiBackend;
  readonly modulePath?: string;
  readonly artifactRoot?: string;
  readonly defaultTimeoutMs?: number;
}

export interface GuiTargetInput {
  readonly window: WindowSelector;
  readonly target: GuiTargetSelector;
  readonly allowCoordinateFallback?: boolean;
  readonly timeoutMs?: number;
}

export interface GuiTypeInput extends GuiTargetInput {
  readonly text: string;
  readonly replace?: boolean;
}

export interface GuiKeysInput {
  readonly window: WindowSelector;
  readonly keys: readonly string[];
  readonly timeoutMs?: number;
}

export interface GuiWaitInput {
  readonly window: WindowSelector;
  readonly target?: GuiTargetSelector;
  readonly condition: "exists" | "not_exists" | "enabled" | "focused";
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export interface GuiCaptureInput {
  readonly window?: WindowSelector;
  readonly name?: string;
  readonly timeoutMs?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function targetingError(error: unknown): GuiActionError {
  if (error instanceof GuiActionError) return error;
  if (error instanceof GuiTargetingError) return new GuiActionError(error.code, error.message);
  return new GuiActionError("backend_error", error instanceof Error ? error.message : String(error));
}

function normalizeEvidence(response: GuiBackendResponse, operation: string, password = false): GuiEvidence {
  const evidence: GuiEvidence = {
    kind: response.evidence?.kind ?? "observed_state",
    ...response.evidence,
    operation,
    verified: response.evidence?.verified === true
  };
  if (password && "value" in evidence) return { ...evidence, value: "[REDACTED]" };
  return evidence;
}

export class GuiService {
  readonly #backend: GuiBackend;
  readonly #screenshots: ScreenshotService;
  readonly #timeoutMs: number;

  public constructor(options: GuiServiceOptions = {}) {
    this.#backend = options.backend ?? createPowerShellUiaClient({
      modulePath: options.modulePath ?? resolve("helpers/powershell/RemoteMcp.UIAutomation.psm1")
    });
    this.#screenshots = new ScreenshotService({
      backend: this.#backend,
      artifactRoot: options.artifactRoot ?? resolve("var/artifacts/screenshots")
    });
    this.#timeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  public async desktops(timeoutMs = this.#timeoutMs): Promise<readonly DesktopInfo[]> {
    const response = await this.#backend.execute({ operation: "desktop_state", payload: {}, timeoutMs });
    if (!response.ok || !response.desktop) throw this.#backendError(response);
    return [response.desktop];
  }

  public async windows(timeoutMs = this.#timeoutMs): Promise<readonly WindowInfo[]> {
    await this.#assertInteractive(timeoutMs);
    const response = await this.#backend.execute({ operation: "windows", payload: {}, timeoutMs });
    if (!response.ok || !response.windows) throw this.#backendError(response);
    return response.windows;
  }

  public async inspect(input: { readonly window: WindowSelector; readonly timeoutMs?: number }): Promise<{
    readonly window: WindowInfo;
    readonly elements: readonly UiElement[];
  }> {
    const timeoutMs = input.timeoutMs ?? this.#timeoutMs;
    const window = selectWindow(await this.windows(timeoutMs), input.window);
    const response = await this.#backend.execute({ operation: "inspect", payload: { window }, timeoutMs });
    if (!response.ok || !response.elements) throw this.#backendError(response);
    return { window: response.window ?? window, elements: response.elements };
  }

  public async focus(selector: WindowSelector, timeoutMs = this.#timeoutMs): Promise<GuiActionResult> {
    await this.#assertInteractive(timeoutMs);
    const window = selectWindow(await this.#windowsUnchecked(timeoutMs), selector);
    return this.#perform("focus", { window }, "uia_semantic", 1, false, timeoutMs);
  }

  public invoke(input: GuiTargetInput): Promise<GuiActionResult> {
    return this.#targetAction("invoke", input);
  }

  public click(input: GuiTargetInput): Promise<GuiActionResult> {
    return this.#targetAction("click", input);
  }

  public type(input: GuiTypeInput): Promise<GuiActionResult> {
    return this.#targetAction("type", input, { text: input.text, replace: input.replace !== false });
  }

  public async keys(input: GuiKeysInput): Promise<GuiActionResult> {
    const timeoutMs = input.timeoutMs ?? this.#timeoutMs;
    await this.#assertInteractive(timeoutMs);
    const window = selectWindow(await this.#windowsUnchecked(timeoutMs), input.window);
    return this.#perform("keys", { window, keys: [...input.keys] }, "uia_semantic", 1, false, timeoutMs);
  }

  public async wait(input: GuiWaitInput): Promise<GuiActionResult> {
    const timeoutMs = input.timeoutMs ?? this.#timeoutMs;
    const pollMs = Math.max(5, input.pollMs ?? 100);
    const deadline = Date.now() + timeoutMs;
    do {
      await this.#assertInteractive(Math.max(1, deadline - Date.now()));
      try {
        const window = selectWindow(await this.#windowsUnchecked(Math.max(1, deadline - Date.now())), input.window);
        let element: UiElement | undefined;
        if (input.target) {
          const inspected = await this.#inspectWindow(window, Math.max(1, deadline - Date.now()));
          element = selectElement(inspected.elements, input.target);
        }
        const matches = input.condition === "exists"
          || (input.condition === "enabled" && element?.enabled === true)
          || (input.condition === "focused" && (element?.focused === true || (!input.target && window.focused)));
        if (matches) {
          return {
            status: "completed",
            strategy: "uia_semantic",
            attempts: 1,
            evidence: {
              kind: "observed_state",
              verified: true,
              operation: "wait",
              condition: input.condition,
              windowHandle: window.handle,
              ...(element === undefined ? {} : { runtimeId: element.runtimeId })
            }
          };
        }
      } catch (error) {
        const mapped = targetingError(error);
        if (input.condition === "not_exists" && mapped.code === "not_found") {
          return {
            status: "completed",
            strategy: "uia_semantic",
            attempts: 1,
            evidence: { kind: "observed_state", verified: true, operation: "wait", condition: input.condition }
          };
        }
        if (mapped.code !== "not_found") throw mapped;
      }
      if (Date.now() < deadline) await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new GuiActionError("timeout", `GUI wait timed out after ${timeoutMs} ms`, { condition: input.condition });
  }

  public async capture(input: GuiCaptureInput = {}): Promise<GuiCaptureResult> {
    const timeoutMs = input.timeoutMs ?? this.#timeoutMs;
    await this.#assertInteractive(timeoutMs);
    const window = input.window === undefined
      ? undefined
      : selectWindow(await this.#windowsUnchecked(timeoutMs), input.window);
    return this.#screenshots.capture(window, input.name ?? `gui-${Date.now()}.png`, timeoutMs);
  }

  async #targetAction(
    operation: "invoke" | "click" | "type",
    input: GuiTargetInput,
    extra: Readonly<Record<string, unknown>> = {}
  ): Promise<GuiActionResult> {
    const timeoutMs = input.timeoutMs ?? this.#timeoutMs;
    await this.#assertInteractive(timeoutMs);
    let lastError: GuiActionError | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const window = selectWindow(await this.#windowsUnchecked(timeoutMs), input.window);
      let payload: Record<string, unknown>;
      let strategy: GuiTargetStrategy;
      let password = false;
      if (input.target.coordinates !== undefined) {
        const coordinate = coordinatePoint(window.bounds, input.target.coordinates, input.allowCoordinateFallback === true);
        payload = { window, point: coordinate.point, ...extra };
        strategy = coordinate.strategy;
      } else {
        const inspected = await this.#inspectWindow(window, timeoutMs);
        const target = selectElement(inspected.elements, input.target);
        payload = { window: inspected.window, target, ...extra };
        strategy = "uia_semantic";
        password = target.password;
      }
      try {
        return await this.#perform(operation, payload, strategy, attempt, password, timeoutMs);
      } catch (error) {
        const mapped = targetingError(error);
        if (mapped.code !== "stale_element" || attempt === 2) throw mapped;
        lastError = mapped;
      }
    }
    throw lastError ?? new GuiActionError("backend_error", "GUI action failed");
  }

  async #perform(
    operation: "focus" | "invoke" | "click" | "type" | "keys",
    payload: Record<string, unknown>,
    strategy: GuiTargetStrategy,
    attempts: number,
    password: boolean,
    timeoutMs: number
  ): Promise<GuiActionResult> {
    const response = await this.#backend.execute({ operation, payload, timeoutMs });
    if (!response.ok) throw this.#backendError(response);
    const evidence = normalizeEvidence(response, operation, password);
    if (!evidence.verified) {
      throw new GuiActionError("postcondition_failed", "GUI action postcondition could not be verified", { operation });
    }
    return { status: "completed", strategy, attempts, evidence };
  }

  async #inspectWindow(window: WindowInfo, timeoutMs: number): Promise<{
    readonly window: WindowInfo;
    readonly elements: readonly UiElement[];
  }> {
    const response = await this.#backend.execute({ operation: "inspect", payload: { window }, timeoutMs });
    if (!response.ok || !response.elements) throw this.#backendError(response);
    return { window: response.window ?? window, elements: response.elements };
  }

  async #windowsUnchecked(timeoutMs: number): Promise<readonly WindowInfo[]> {
    const response = await this.#backend.execute({ operation: "windows", payload: {}, timeoutMs });
    if (!response.ok || !response.windows) throw this.#backendError(response);
    return response.windows;
  }

  async #assertInteractive(timeoutMs: number): Promise<void> {
    const response = await this.#backend.execute({ operation: "desktop_state", payload: {}, timeoutMs });
    if (response.secureDesktop || response.desktop?.interactive === false) {
      throw new GuiActionError("needs_attention", "Windows secure desktop requires direct user attention", {
        reason: "secure_desktop",
        desktop: response.desktop?.name ?? "unknown"
      });
    }
    if (!response.ok) throw this.#backendError(response);
  }

  #backendError(response: GuiBackendResponse): GuiActionError {
    const code = response.code;
    if (code === "stale_element") return new GuiActionError("stale_element", response.message ?? "UI element became stale");
    if (code === "needs_attention" || code === "secure_desktop") {
      return new GuiActionError("needs_attention", response.message ?? "GUI action needs user attention", {
        reason: code === "secure_desktop" ? "secure_desktop" : "backend_attention"
      });
    }
    return new GuiActionError("backend_error", response.message ?? code ?? "GUI backend failed");
  }
}

export function createGuiService(options: GuiServiceOptions = {}): GuiService {
  return new GuiService(options);
}
