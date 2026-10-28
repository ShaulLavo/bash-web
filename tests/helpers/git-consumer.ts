import { createRuntime, type Runtime } from "waffle";
import { installGit, type GitInstallation } from "waffle-git";
import { captureGit } from "./git-output";

const environment = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Fixture Committer",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
};

let runtime: Runtime | undefined;
let installation: GitInstallation | undefined;
let admissions = 0;

function owner() {
  if (!runtime) throw new Error("Git consumer runtime is not initialized");
  return runtime;
}

const api = {
  async setup() {
    runtime = createRuntime({
      filesystem: { mode: "memory", workerURL: "/fs-worker.js" },
      onProcessAdmission() {
        admissions++;
      },
    });
    await runtime.filesystem.mkdirp("/repo");
    installation = await installGit(runtime);
    return { admissions, disposed: runtime.disposed };
  },
  async run(argv: readonly string[]) {
    if (!installation) throw new Error("Git is not installed");
    return captureGit(installation.run, { argv, cwd: "/repo", env: environment });
  },
  async write(path: string, text: string) {
    await owner().filesystem.writeFile(`/repo/${path}`, text);
  },
  async release() {
    if (!installation) throw new Error("Git is not installed");
    await installation.dispose();
    await installation.dispose();
    const disposed = owner().disposed;
    await owner().filesystem.writeFile("/caller-still-live", "yes");
    return {
      disposed,
      admissions,
      caller: new TextDecoder().decode(await owner().filesystem.readFile("/caller-still-live")),
    };
  },
  async cleanup() {
    await installation?.dispose();
    await runtime?.dispose();
    installation = undefined;
    runtime = undefined;
  },
};

declare global {
  interface Window {
    gitConsumerTest: typeof api;
  }
}
window.gitConsumerTest = api;
