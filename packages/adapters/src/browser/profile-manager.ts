import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface BrowserProfileLease {
  readonly workspaceId: string;
  readonly profileKey: string;
  readonly path: string;
  release(): Promise<void>;
}

export interface BrowserProfileLock {
  acquire(key: string, ownerId: string): Promise<() => Promise<void>>;
}

export class InMemoryBrowserLock implements BrowserProfileLock {
  readonly #owners = new Map<string, string>();

  public async acquire(key: string, ownerId: string): Promise<() => Promise<void>> {
    const existing = this.#owners.get(key);
    if (existing !== undefined && existing !== ownerId) {
      throw new Error(`Browser profile lock is already in use: ${key}`);
    }
    this.#owners.set(key, ownerId);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (this.#owners.get(key) === ownerId) this.#owners.delete(key);
    };
  }
}

export interface ProfileManagerOptions {
  readonly root: string;
  readonly lock?: BrowserProfileLock;
}

export class BrowserProfileManager {
  readonly #root: string;
  readonly #lock: BrowserProfileLock;

  public constructor(options: ProfileManagerOptions) {
    this.#root = resolve(options.root);
    this.#lock = options.lock ?? new InMemoryBrowserLock();
  }

  public async acquire(workspaceId: string): Promise<BrowserProfileLease> {
    if (workspaceId.length < 1 || workspaceId.length > 512) throw new Error("Workspace ID is invalid");
    const profileKey = createHash("sha256").update(workspaceId, "utf8").digest("hex");
    const ownerId = randomUUID();
    const release = await this.#lock.acquire(`browser-profile:${profileKey}`, ownerId);
    const path = resolve(this.#root, profileKey);
    try {
      await mkdir(path, { recursive: true });
    } catch (error) {
      await release();
      throw error;
    }
    return { workspaceId, profileKey, path, release };
  }
}

export function createInMemoryBrowserLock(): InMemoryBrowserLock {
  return new InMemoryBrowserLock();
}

export function createBrowserProfileManager(options: ProfileManagerOptions): BrowserProfileManager {
  return new BrowserProfileManager(options);
}
