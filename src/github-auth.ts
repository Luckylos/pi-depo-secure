import { portableGitHubTokenStore } from "./credential-store.js";

export type GitHubAuthSource = "credential-store" | "none";

export interface GitHubAuthStatus {
  authenticated: boolean;
  source: GitHubAuthSource;
  detail: string;
}

export interface GitHubTokenStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
}

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const KEYCHAIN_SERVICE = "pi-depo-secure/github";
const KEYCHAIN_ACCOUNT = "github";
const DEFAULT_SCOPE = "gist";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface GitHubAuthDependencies {
  env?: NodeJS.ProcessEnv;
  tokenStore?: GitHubTokenStore;
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

export function defaultGitHubTokenStore(): GitHubTokenStore {
  const portable = portableGitHubTokenStore();
  let selected: GitHubTokenStore | undefined;
  const select = async (): Promise<GitHubTokenStore> => {
    if (selected) return selected;
    const system = systemGitHubTokenStore();
    try {
      await system.get();
      selected = system;
    } catch {
      selected = portable;
    }
    return selected;
  };
  return {
    async get(): Promise<string | undefined> {
      return (await select()).get();
    },
    async set(token: string): Promise<void> {
      const store = await select();
      try {
        await store.set(token);
      } catch (error) {
        if (store === portable) throw error;
        selected = portable;
        await portable.set(token);
      }
    },
  };
}

function missingAuthDetail(env: NodeJS.ProcessEnv, storeError: boolean): string {
  if (storeError) {
    return "The local credential store is unavailable. Check that the user configuration directory is writable.";
  }
  if (!env.PI_GITHUB_OAUTH_CLIENT_ID?.trim()) {
    return "No GitHub authorization found. Set PI_GITHUB_OAUTH_CLIENT_ID, then run /gist-sync auth.";
  }
  return "No GitHub authorization found. Run /gist-sync auth.";
}

async function tokenFromStore(store: GitHubTokenStore): Promise<string | undefined> {
  const token = await store.get();
  return token?.trim() || undefined;
}

export async function githubAuthStatus(options: GitHubAuthDependencies = {}): Promise<GitHubAuthStatus> {
  const env = options.env ?? process.env;
  const store = options.tokenStore ?? defaultGitHubTokenStore();
  try {
    if (await tokenFromStore(store)) {
      return { authenticated: true, source: "credential-store", detail: "GitHub token is available in the local credential store" };
    }
    return { authenticated: false, source: "none", detail: missingAuthDetail(env, false) };
  } catch {
    return { authenticated: false, source: "none", detail: missingAuthDetail(env, true) };
  }
}

export async function githubTokenFromAuth(options: GitHubAuthDependencies = {}): Promise<string> {
  const store = options.tokenStore ?? defaultGitHubTokenStore();
  try {
    const token = await tokenFromStore(store);
    if (token) return token;
  } catch {
    throw new Error("The local credential store is unavailable. Check that the user configuration directory is writable, then run /gist-sync auth again.");
  }
  throw new Error("No GitHub authorization found. Run /gist-sync auth.");
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
    case "incorrect_client_credentials": return new Error("GitHub OAuth Client ID is invalid");
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
    if (tokenResponse.ok && token.access_token) {
      try {
        await store.set(token.access_token);
      } catch {
        throw new Error("GitHub authorization succeeded, but the token could not be saved to the local credential store. Check that the user configuration directory is writable and run /gist-sync auth again.");
      }
      return { authenticated: true, source: "credential-store", detail: "GitHub token stored in the local credential store" };
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
  const before = await githubAuthStatus(options);
  if (before.authenticated) return before;
  if (/local credential store is unavailable/i.test(before.detail)) throw new Error(before.detail);

  const clientId = (options.clientId ?? env.PI_GITHUB_OAUTH_CLIENT_ID)?.trim();
  if (!clientId) throw new Error("Set PI_GITHUB_OAUTH_CLIENT_ID, then run /gist-sync auth.");
  const store = options.tokenStore ?? defaultGitHubTokenStore();
  return authenticateGithubDeviceFlow(options, clientId, store);
}
