import { connect } from "node:net";

import type { WatchAdapter, WatchProbeInput, WatchProbeResult } from "./file-watch.js";

export type PortProbe = (host: string, port: number) => boolean | Promise<boolean>;

export class PortWatchAdapter implements WatchAdapter {
  public readonly kind = "port";

  public constructor(private readonly inspect: PortProbe = defaultPortProbe) {}

  public async probe(input: WatchProbeInput): Promise<WatchProbeResult> {
    const match = /^(.*):(\d+)$/u.exec(input.target);
    if (!match) throw new Error("Port watch target must be host:port");
    const host = match[1] || "127.0.0.1";
    const port = Number(match[2]);
    const open = await this.inspect(host, port);
    const fingerprint = open ? "open" : "closed";
    return {
      fingerprint,
      events: input.fingerprint === null || input.fingerprint === fingerprint
        ? []
        : [{ type: open ? "port_opened" : "port_closed", payload: { host, port } }]
    };
  }
}

function defaultPortProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolveProbe(false); }, 1_000);
    timer.unref();
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveProbe(true); });
    socket.once("error", () => { clearTimeout(timer); resolveProbe(false); });
  });
}
