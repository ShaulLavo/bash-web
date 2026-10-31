import type { PromptFilesystem } from "./types";

export type PromptEntry = Awaited<ReturnType<PromptFilesystem["lookup"]>>;

export class TurnFilesystem {
  private readonly lookups = new Map<string, Promise<PromptEntry>>();
  private readonly reads = new Map<string, Promise<Uint8Array | undefined>>();
  private count = 0;

  constructor(readonly filesystem: PromptFilesystem) {}

  lookup(path: string): Promise<PromptEntry> {
    const existing = this.lookups.get(path);
    if (existing) return existing;
    const request = this.filesystem.lookup(path);
    this.lookups.set(path, request);
    this.count++;
    return request;
  }

  readFile(path: string): Promise<Uint8Array | undefined> {
    const existing = this.reads.get(path);
    if (existing) return existing;
    const request = this.filesystem.readFile(path);
    this.reads.set(path, request);
    this.count++;
    return request;
  }

  get requestCount(): number {
    return this.count;
  }
}
