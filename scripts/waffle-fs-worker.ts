import { installFilesystemWorker, MemoryBackend } from "waffle/fs";

interface FilesystemScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown, transfer?: readonly unknown[]): void;
}

function installSession(scope: FilesystemScope): void {
  installFilesystemWorker(scope as Parameters<typeof installFilesystemWorker>[0], (options) => {
    const config = options as { startupRoot?: unknown; connect?: unknown };
    return new MemoryBackend(
      undefined,
      undefined,
      config.startupRoot as ConstructorParameters<typeof MemoryBackend>[2],
      undefined,
      config.connect as ConstructorParameters<typeof MemoryBackend>[4],
    );
  });
}

const host = globalThis as unknown as {
  __bashWebPooledWorker?: boolean;
  __bashWebInstallSession?: (scope: FilesystemScope) => void;
};

if (host.__bashWebPooledWorker) {
  host.__bashWebInstallSession = installSession;
} else {
  installSession(globalThis as unknown as FilesystemScope);
}
