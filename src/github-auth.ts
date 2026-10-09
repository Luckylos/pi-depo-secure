import { spawn } from "node:child_process";
import { commandExists, runCommand } from "./process.js";

export type GitHubAuthSource = "environment" | "gh" | "none";

export interface GitHubAuthStatus {
  authenticated: boolean;
  source: GitHubAuthSource;
  detail: string;
}

export function githubEnvironmentToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return [env.GITHUB_TOKEN, env.GH_TOKEN].find((value) => value?.trim())?.trim();
}

const LOGIN_ARGS = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--scopes", "gist", "--web"];
const DEVICE_LOGIN_SCRIPT = "printf '\n' | gh auth login --hostname github.com --git-protocol https --scopes gist --web";

export function githubLoginArgs(): string[] { return [...LOGIN_ARGS]; }

export async function githubAuthStatus(): Promise<GitHubAuthStatus> {
  if (githubEnvironmentToken()) {
    return { authenticated: true, source: "environment", detail: "GitHub token is available from the environment" };
  }

  if (!await commandExists("gh")) {
    return { authenticated: false, source: "none", detail: "GitHub CLI (gh) is not installed. Install gh, then run /gist-sync auth again." };
  }

  const status = await runCommand("gh", ["auth", "status", "--hostname", "github.com"], { timeoutMs: 10_000 });
  if (status.exitCode === 0) return { authenticated: true, source: "gh", detail: "GitHub CLI authentication is available" };

  // Some gh versions can return a non-zero status while still returning a usable token.
  const token = await runCommand("gh", ["auth", "token", "--hostname", "github.com"], { timeoutMs: 10_000 });
  if (token.exitCode === 0 && token.stdout.toString("utf8").trim()) {
    return { authenticated: true, source: "gh", detail: "GitHub CLI token is available" };
  }

  return { authenticated: false, source: "gh", detail: "GitHub is not authenticated. Start the browser/device login flow with /gist-sync auth." };
}

export interface GitHubLoginOptions {
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
}

export async function authenticateGithub(options: GitHubLoginOptions = {}): Promise<GitHubAuthStatus> {
  const before = await githubAuthStatus();
  if (before.authenticated) return before;
  if (before.source === "none") throw new Error(before.detail);

  const usePseudoTerminal = await commandExists("script");
  const file = usePseudoTerminal ? "script" : "gh";
  const args = usePseudoTerminal ? ["-qefc", DEVICE_LOGIN_SCRIPT, "/dev/null"] : LOGIN_ARGS;
  const output: string[] = [];
  const result = await runStreamingCommand(file, args, {
    input: usePseudoTerminal ? undefined : "\n",
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    env: { ...process.env, NO_COLOR: "1" },
    onOutput: (chunk) => {
      output.push(chunk);
      options.onOutput?.(chunk);
    },
  });
  if (result.exitCode !== 0) {
    throw new Error("GitHub browser/device authentication failed. Run /gist-sync auth again and complete the web flow.");
  }

  const after = await githubAuthStatus();
  if (!after.authenticated) throw new Error("GitHub browser/device authentication did not complete. Run /gist-sync auth again.");
  return after;
}

interface StreamingCommandOptions {
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  onOutput?: (chunk: string) => void;
}

async function runStreamingCommand(file: string, args: string[], options: StreamingCommandOptions): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode });
    };
    const forward = (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8"));
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", () => finish(-1));
    child.on("close", (exitCode) => finish(exitCode ?? -1));
    if (options.input === undefined) child.stdin.end(); else child.stdin.end(options.input);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(-1);
    }, options.timeoutMs);
  });
}
