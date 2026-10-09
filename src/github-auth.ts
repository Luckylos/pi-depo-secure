import { spawn } from "node:child_process";
import { commandExists, runCommand } from "./process.js";

export type GitHubAuthSource = "environment" | "keychain" | "gh" | "none";

export interface GitHubAuthStatus {
  authenticated: boolean;
  source: GitHubAuthSource;
  detail: string;
}

export interface GitHubTokenStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
}

export function githubEnvironmentToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return [env.GITHUB_TOKEN, env.GH_TOKEN].find((value) => value?.trim())?.trim();
}

const LOGIN_ARGS = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--scopes", "gist", "--web"];
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const KEYCHAIN_SERVICE = "pi-depo-secure/github";
const KEYCHAIN_ACCOUNT = "github";
const DEFAULT_SCOPE = "gist";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function githubLoginArgs(): string[] { return [...LOGIN_ARGS]; }

export interface GitHubAuthDependencies {
  env?: NodeJS.ProcessEnv;
  tokenStore?: GitHubTokenStore;
  commandExists?: typeof commandExists;
  runCommand?: typeof runCommand;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  clientId?: string;
}

export interface GitHubLoginOptions extends GitHubAuthDependencies {
  onOutput?: (chunk: string) => void;
  timeoutMs?: number;
}

let keytarPromise: Promise<typeof import("keytar")> | undefined;

async function loadKeytar(): Promise<typeof import("keytar")> {
  keytarPromise ??= import("keytar");
  return keytarPromise;
}

export function systemGitHubTokenStore(): GitHubTokenStore {
  return {
    async get(): Promise<string | undefined> {
      const keytar = await loadKeytar();
      const token = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      return token?.trim() || undefined;
    },
    async set(token: string): Promise<void> {
      if (!token.trim()) throw new Error("Cannot store an empty GitHub token");
      const keytar = await loadKeytar();
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token);
    },
  };
}

function authUnavailableDetail(env: NodeJS.ProcessEnv, keychainError: boolean): string {
  const keychain = keychainError ? " The system keychain is unavailable." : "";
  const direct = env.PI_GITHUB_OAUTH_CLIENT_ID?.trim()
    ? " Run /gist-sync auth to start the configured GitHub Device Flow."
    : " Set PI_GITHUB_OAUTH_CLIENT_ID to enable the built-in Device Flow.";
  return "GitHub authentication is unavailable. Install gh and run /gist-sync auth, set GITHUB_TOKEN or GH_TOKEN," + direct + keychain;
}

async function tokenFromStore(store: GitHubTokenStore): Promise<string | undefined> {
  const token = await store.get();
  return token?.trim() || undefined;
}

async function tokenFromGh(
  env: NodeJS.ProcessEnv,
  checkCommand: typeof commandExists,
  run: typeof runCommand,
): Promise<string | undefined> {
  if (!await checkCommand("gh", env)) return undefined;
  const token = await run("gh", ["auth", "token", "--hostname", "github.com"], { timeoutMs: 10_000, env });
  const value = token.stdout.toString("utf8").trim();
  return token.exitCode === 0 && value ? value : undefined;
}

export async function githubAuthStatus(options: GitHubAuthDependencies = {}): Promise<GitHubAuthStatus> {
  const env = options.env ?? process.env;
  const checkCommand = options.commandExists ?? commandExists;
  const run = options.runCommand ?? runCommand;
  const store = options.tokenStore ?? systemGitHubTokenStore();

  if (githubEnvironmentToken(env)) {
    return { authenticated: true, source: "environment", detail: "GitHub token is available from the environment" };
  }

  let keychainError = false;
  try {
    if (await tokenFromStore(store)) {
      return { authenticated: true, source: "keychain", detail: "GitHub token is available from the system keychain" };
    }
  } catch {
    keychainError = true;
  }

  if (!await checkCommand("gh", env)) {
    return { authenticated: false, source: "none", detail: authUnavailableDetail(env, keychainError) };
  }

  const status = await run("gh", ["auth", "status", "--hostname", "github.com"], { timeoutMs: 10_000, env });
  if (status.exitCode === 0) return { authenticated: true, source: "gh", detail: "GitHub CLI authentication is available" };

  // Some gh versions can return a non-zero status while still returning a usable token.
  if (await tokenFromGh(env, checkCommand, run)) {
    return { authenticated: true, source: "gh", detail: "GitHub CLI token is available" };
  }

  return { authenticated: false, source: "gh", detail: "GitHub is not authenticated. Start the browser/device login flow with /gist-sync auth." };
}

export async function githubTokenFromAuth(options: GitHubAuthDependencies = {}): Promise<string> {
  const env = options.env ?? process.env;
  const checkCommand = options.commandExists ?? commandExists;
  const run = options.runCommand ?? runCommand;
  const store = options.tokenStore ?? systemGitHubTokenStore();

  const environmentToken = githubEnvironmentToken(env);
  if (environmentToken) return environmentToken;

  try {
    const keychainToken = await tokenFromStore(store);
    if (keychainToken) return keychainToken;
  } catch {
    // Try the other supported credential source and report a redacted error below if none work.
  }

  const ghToken = await tokenFromGh(env, checkCommand, run);
  if (ghToken) return ghToken;

  throw new Error(authUnavailableDetail(env, false) + " Run /gist-sync auth first.");
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
}

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  interval?: number;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new Error("GitHub authentication service returned an invalid response");
  }
}

function deviceFlowError(code: string | undefined): Error {
  switch (code) {
    case "authorization_pending": return new Error("GitHub authorization is still pending");
    case "slow_down": return new Error("GitHub requested slower authorization polling");
    case "expired_token": return new Error("GitHub Device Flow code expired; run /gist-sync auth again");
    case "access_denied": return new Error("GitHub Device Flow authorization was denied");
    case "incorrect_client_credentials": return new Error("GitHub OAuth client ID is invalid");
    default: return new Error("GitHub Device Flow authorization failed");
  }
}

async function authenticateGithubDeviceFlow(options: GitHubLoginOptions, clientId: string, store: GitHubTokenStore): Promise<GitHubAuthStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deviceResponse = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: DEFAULT_SCOPE }).toString(),
  });
  const device = await jsonResponse<DeviceCodeResponse>(deviceResponse);
  if (!deviceResponse.ok || device.error || !device.device_code || !device.user_code || !device.verification_uri) {
    throw deviceFlowError(device.error);
  }

  const verificationUri = device.verification_uri_complete ?? device.verification_uri;
  options.onOutput?.("Open " + verificationUri + "\nEnter code: " + device.user_code + "\n");

  const expiresAt = now() + Math.min(timeoutMs, Math.max(1, device.expires_in ?? 900) * 1000);
  let intervalSeconds = Math.max(1, device.interval ?? 5);
  while (now() < expiresAt) {
    const tokenResponse = await fetchImpl(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, device_code: device.device_code, grant_type: DEVICE_GRANT_TYPE }).toString(),
    });
    const token = await jsonResponse<AccessTokenResponse>(tokenResponse);
    if (token.access_token) {
      try {
        await store.set(token.access_token);
      } catch {
        throw new Error("GitHub authorization succeeded, but the access token could not be saved to the system keychain. Install a supported keychain or use GITHUB_TOKEN for this process.");
      }
      return { authenticated: true, source: "keychain", detail: "GitHub token stored in the system keychain" };
    }
    if (token.error === "authorization_pending") {
      await sleep(intervalSeconds * 1000);
      continue;
    }
    if (token.error === "slow_down") {
      intervalSeconds = Math.max(intervalSeconds + 5, token.interval ?? 0);
      await sleep(intervalSeconds * 1000);
      continue;
    }
    throw deviceFlowError(token.error);
  }

  throw new Error("GitHub Device Flow timed out; run /gist-sync auth again");
}

export async function authenticateGithub(options: GitHubLoginOptions = {}): Promise<GitHubAuthStatus> {
  const env = options.env ?? process.env;
  const checkCommand = options.commandExists ?? commandExists;
  const before = await githubAuthStatus(options);
  if (before.authenticated) return before;

  const store = options.tokenStore ?? systemGitHubTokenStore();
  const clientId = (options.clientId ?? env.PI_GITHUB_OAUTH_CLIENT_ID)?.trim();
  if (clientId) return authenticateGithubDeviceFlow(options, clientId, store);

  if (before.source === "none") throw new Error(before.detail);

  const usePseudoTerminal = await checkCommand("script", env);
  const file = usePseudoTerminal ? "script" : "gh";
  const args = usePseudoTerminal ? ["-qefc", "printf '\n' | gh auth login --hostname github.com --git-protocol https --scopes gist --web", "/dev/null"] : LOGIN_ARGS;
  const output: string[] = [];
  const result = await runStreamingCommand(file, args, {
    input: usePseudoTerminal ? undefined : "\n",
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: { ...env, NO_COLOR: "1" },
    onOutput: (chunk) => {
      output.push(chunk);
      options.onOutput?.(chunk);
    },
  });
  if (result.exitCode !== 0) {
    throw new Error("GitHub browser/device authentication failed. Run /gist-sync auth again and complete the web flow.");
  }

  const after = await githubAuthStatus(options);
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
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode });
    };
    const forward = (chunk: Buffer) => options.onOutput?.(chunk.toString("utf8"));
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", () => finish(-1));
    child.on("close", (exitCode) => finish(exitCode ?? -1));
    if (options.input === undefined) child.stdin.end(); else child.stdin.end(options.input);
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(-1);
    }, options.timeoutMs);
  });
}
