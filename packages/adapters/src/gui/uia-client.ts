import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { DesktopInfo, GuiEvidence, UiElement, WindowInfo } from "./window-model.js";

export type GuiBackendOperation =
  | "desktop_state"
  | "windows"
  | "inspect"
  | "focus"
  | "invoke"
  | "click"
  | "type"
  | "keys"
  | "capture";

export interface GuiBackendRequest {
  readonly operation: GuiBackendOperation;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface GuiBackendResponse {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly secureDesktop?: boolean;
  readonly desktop?: DesktopInfo;
  readonly windows?: readonly WindowInfo[];
  readonly window?: WindowInfo;
  readonly elements?: readonly UiElement[];
  readonly evidence?: Partial<GuiEvidence>;
}

export interface GuiBackend {
  execute(request: GuiBackendRequest): Promise<GuiBackendResponse>;
}

export interface PowerShellUiaClientOptions {
  readonly modulePath: string;
  readonly executable?: string;
  readonly maxOutputBytes?: number;
}

function safeError(value: string): string {
  const compact = value.replace(/[\r\n]+/gu, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}…` : compact;
}

export class PowerShellUiaClient implements GuiBackend {
  readonly #modulePath: string;
  readonly #executable: string;
  readonly #maxOutputBytes: number;

  public constructor(options: PowerShellUiaClientOptions) {
    this.#modulePath = resolve(options.modulePath);
    this.#executable = options.executable ?? "powershell.exe";
    this.#maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  }

  public execute(request: GuiBackendRequest): Promise<GuiBackendResponse> {
    return new Promise((resolvePromise, reject) => {
      const escapedModule = this.#modulePath.replace(/'/gu, "''");
      const child = spawn(
        this.#executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Import-Module -Name '${escapedModule}' -Force; Invoke-RemoteMcpUiCommand`
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
            WINDIR: process.env.WINDIR ?? "C:\\Windows",
            PATH: process.env.PATH ?? ""
          }
        }
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(`GUI helper timed out after ${request.timeoutMs} ms`)));
      }, request.timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.#maxOutputBytes) {
          child.kill();
          finish(() => reject(new Error("GUI helper exceeded its output limit")));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(stderr).length < 32_768) stderr.push(chunk);
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code) => {
        finish(() => {
          if (code !== 0) {
            reject(new Error(`GUI helper failed (${code ?? "unknown"}): ${safeError(Buffer.concat(stderr).toString("utf8"))}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(Buffer.concat(stdout).toString("utf8")) as GuiBackendResponse);
          } catch {
            reject(new Error("GUI helper returned invalid JSON"));
          }
        });
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  }
}

export function createPowerShellUiaClient(options: PowerShellUiaClientOptions): PowerShellUiaClient {
  return new PowerShellUiaClient(options);
}
