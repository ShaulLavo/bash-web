// Shared by fresh captures and the frozen-observation transport audit.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { drainGroup, killGroup } from "./shell-process-group.ts";

const pipeLauncher = resolve(import.meta.dirname, "bash-compat-pipe.py");
export const bashStdoutTransport =
  "Python3 subprocess stdout=PIPE forwarded byte-for-byte; explicit fd3 exit status";
export const bashStderrTransport =
  "Independent Python3 subprocess stderr=PIPE forwarded byte-for-byte";

export interface BufferedResult {
  stdout: Buffer;
  stderr: Buffer;
  status?: number;
  timeout?: boolean;
  outputLimit?: boolean;
  crash?: string;
}

export interface ShellResult extends BufferedResult {
  status: number;
  timeout: boolean;
  outputLimit: boolean;
}

export interface ScratchDirectories {
  directory: string;
  tmp: string;
  home: string;
}

export type ActiveChildren = Map<() => void, Promise<ShellResult>>;
export type StdoutTransport = "pipe" | "socket";

interface ShellRunnerOptions {
  scratch: string;
  timeoutMs: number;
  activeChildren?: ActiveChildren;
  onScratchCreated?: (directories: ScratchDirectories) => void;
}

export function createShellRunner({
  scratch,
  timeoutMs,
  activeChildren = new Map(),
  onScratchCreated,
}: ShellRunnerOptions) {
  return async function runShell(
    shell: string,
    code: string,
    path: string,
    sandbox = false,
    transport: StdoutTransport = "pipe",
  ): Promise<ShellResult> {
    if (transport !== "pipe" && transport !== "socket") throw new Error("Unknown stdout transport");
    const directory = await mkdtemp(resolve(scratch, "bash-"));
    const tmp = resolve(directory, "tmp");
    const home = resolve(directory, "home");
    let ownership: Promise<ShellResult> | undefined;
    try {
      await mkdir(tmp);
      await mkdir(home);
      onScratchCreated?.({ directory, tmp, home });
      const sandboxArgs = [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--bind",
        directory,
        directory,
        "--ro-bind",
        resolve(scratch, "helpers"),
        resolve(scratch, "helpers"),
        "--ro-bind",
        shell,
        shell,
        "--chdir",
        tmp,
        "--",
        shell,
        "-c",
        code,
      ];
      const command = sandbox ? "bwrap" : shell;
      const args = sandbox ? sandboxArgs : ["-c", code];
      const realPipe = transport === "pipe";
      const child = spawn(
        realPipe ? "/usr/bin/python3" : command,
        realPipe ? [pipeLauncher, String(process.pid), command].concat(args) : args,
        {
          cwd: tmp,
          env: { PATH: path, HOME: home, TMP: tmp, SH: "bash", LC_ALL: "C.UTF-8" },
          stdio: realPipe ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      const kill = () => killGroup(child.pid, "SIGKILL");
      ownership = (async () => {
        try {
          return await collectShell(child, kill, tmp, home, timeoutMs, realPipe);
        } finally {
          kill();
          await drainGroup(child.pid);
          await rm(directory, { recursive: true, force: true });
          activeChildren.delete(kill);
        }
      })();
      // Teardown callers await the whole lifetime, including the termination barrier.
      activeChildren.set(kill, ownership);
      return await ownership;
    } finally {
      if (!ownership) await rm(directory, { recursive: true, force: true });
    }
  };
}

function collectShell(
  child: ChildProcess,
  kill: () => void,
  tmp: string,
  home: string,
  timeoutMs: number,
  realPipe: boolean,
): Promise<ShellResult> {
  return new Promise((done, fail) => {
    assert.ok(child.stdout && child.stderr);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const protocol: Buffer[] = [];
    let protocolBytes = 0;
    let timeout = false;
    let outputLimit = false;
    let bytes = 0;
    const timer = setTimeout(() => {
      timeout = true;
      kill();
    }, timeoutMs);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) return chunks.push(chunk);
      outputLimit = true;
      kill();
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    if (realPipe) {
      const statusStream = child.stdio[3];
      assert.ok(statusStream instanceof Readable);
      statusStream.on("data", (chunk: Buffer) => {
        protocolBytes += chunk.length;
        if (protocolBytes <= 256) protocol.push(chunk);
        else kill();
      });
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("exit", kill);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      let shellStatus = status ?? 128 + ((signal && constants.signals[signal]) ?? 0);
      if (realPipe && !timeout && !outputLimit) {
        try {
          const message: unknown = JSON.parse(Buffer.concat(protocol).toString("ascii"));
          if (
            status !== 0 ||
            protocolBytes > 256 ||
            typeof message !== "object" ||
            message === null ||
            !("status" in message) ||
            typeof message.status !== "number" ||
            !Number.isInteger(message.status) ||
            message.status < 0 ||
            message.status > 255
          )
            throw new Error("invalid launcher status");
          shellStatus = message.status;
        } catch (error) {
          fail(new Error(`Bash pipe launcher failed: ${Buffer.concat(stderr)}`, { cause: error }));
          return;
        }
      }
      done(
        normalize(
          {
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            status: shellStatus,
            timeout,
            outputLimit,
          },
          [
            [tmp, "$TMP"],
            [home, "$HOME"],
          ],
        ),
      );
    });
  });
}

export function normalize<T extends BufferedResult>(
  result: T,
  paths: readonly (readonly [string, string])[],
): T {
  const replace = (bytes: Buffer) => {
    let text = bytes.toString("latin1");
    for (const [from, to] of paths) text = text.split(from).join(to);
    return Buffer.from(text, "latin1");
  };
  return { ...result, stdout: replace(result.stdout), stderr: replace(result.stderr) };
}
