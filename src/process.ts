import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  errorCode?: string;
  signal?: NodeJS.Signals | null;
  text(): string;
}

export async function runCommand(file: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<CommandResult, "text">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, text: () => result.stdout.toString("utf8") });
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => finish({ exitCode: -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), errorCode: error.code }));
    child.on("close", (exitCode, signal) => finish({ exitCode: exitCode ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), signal }));
    if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ exitCode: -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), errorCode: "ETIMEDOUT", signal: "SIGTERM" });
      }, options.timeoutMs);
    }
  });
}

export async function commandExists(file: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (isAbsolute(file) || file.includes("/")) {
    try { await access(file, constants.X_OK); return true; } catch { return false; }
  }
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try { await access(join(directory, file), constants.X_OK); return true; } catch { /* continue */ }
  }
  return false;
}

export function formatCommandError(file: string, args: string[], result: CommandResult): Error {
  const detail = result.errorCode ?? (result.stderr.toString("utf8").trim().slice(0, 500) || ("exit " + result.exitCode));
  return new Error("Command failed: " + file + " " + args.join(" ") + " (" + detail + ")");
}

export async function runShellCommand(command: string, options: RunOptions = {}): Promise<CommandResult> {
  return runCommand("sh", ["-c", command], options);
}
