import { join } from "node:path";

import { spawn, type IPty } from "node-pty";

import { RemoteMcpError } from "@remote-mcp/contracts";

export type TerminalShell = "powershell" | "cmd" | "python" | "node";

export interface PtySpawnOptions {
  readonly shell: TerminalShell;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env?: Readonly<Record<string, string>>;
}

function shellCommand(shell: TerminalShell): { readonly file: string; readonly args: readonly string[] } {
  switch (shell) {
    case "powershell":
      return {
        file: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        args: ["-NoLogo", "-NoProfile", "-NoExit"]
      };
    case "cmd":
      return { file: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), args: ["/Q"] };
    case "python":
      return { file: "python.exe", args: ["-i", "-q"] };
    case "node":
      return { file: process.execPath, args: ["-i"] };
  }
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

export function spawnPty(options: PtySpawnOptions): IPty {
  const command = shellCommand(options.shell);
  try {
    return spawn(command.file, [...command.args], {
      name: "xterm-256color",
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: { ...inheritedEnvironment(), ...options.env },
      useConpty: true
    });
  } catch (error) {
    throw new RemoteMcpError({
      errorCode: "CAPABILITY_UNAVAILABLE",
      message: `${options.shell} terminal is unavailable on this computer.`,
      retryable: false,
      suggestedAction: `Install or repair ${options.shell}, then run capability self-test.`,
      target: options.shell,
      cause: error
    });
  }
}
