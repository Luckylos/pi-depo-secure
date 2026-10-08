import { runCommand } from "./process.js"
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { RemoteProvider, PkitConfig } from "./types.js";
import { loadConfig, saveConfig, remoteRawUrl, remoteApiUrl } from "./config.js";

// ─── Token resolution ───────────────────────────────────────────
// Tokens are deliberately never persisted by this fork. Prefer environment variables,
// then read the credential from gh without invoking a shell.
async function githubTokenFromCLI(): Promise<string> {
  const status = await runCommand("gh", ["auth", "status"], { timeoutMs: 10_000 });
  if (status.exitCode !== 0) throw new Error("GitHub CLI is not authenticated. Run: gh auth login --scopes gist");
  const token = await runCommand("gh", ["auth", "token"], { timeoutMs: 10_000 });
  const value = token.stdout.toString("utf8").trim();
  if (token.exitCode !== 0 || !value) throw new Error("Could not retrieve token from GitHub CLI. Run: gh auth login --scopes gist");
  return value;
}

export async function tokenForProvider(provider: RemoteProvider): Promise<string> {
  if (provider === "github") {
    const fromEnvironment = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (fromEnvironment?.trim()) return fromEnvironment.trim();
    return await githubTokenFromCLI();
  }
  const fromEnvironment = process.env.CODEBERG_TOKEN;
  if (fromEnvironment?.trim()) return fromEnvironment.trim();
  throw new Error("Codeberg authentication requires CODEBERG_TOKEN");
}

// ─── Login command ──────────────────────────────────────────────
export async function login(provider: RemoteProvider = "github"): Promise<void> {
  console.log(`Logging in to ${provider}...`);

  const token = await tokenForProvider(provider);
  const config = await loadConfig();

  const user = await fetchUser(provider, token);
  console.log(`  Authenticated as: ${user}`);

  if (!config.profiles) config.profiles = {};
  if (!config.profiles.default) {
    config.profiles.default = { provider, user, repo: "gists", path: "pi-depo.yml" };
    config.active_profile = "default";
  }

  // Auto-discover existing gist with kit.yml on this account
  if (provider === "github" && !config.profiles.default.gist_id) {
    console.log("  Searching for existing kit.yml gist...");
    const gistId = await findKitGist(token, config.profiles.default.path ?? "pi-depo.yml");
    if (gistId) {
      config.profiles.default.gist_id = gistId;
      console.log(`  Found existing gist: ${gistId}`);
    } else {
      console.log("  No existing gist found - will create one on first 'pd push'.");
    }
  }

  await saveConfig(config);
  console.log("  Login saved without persisting credentials. Run 'pd sync' when you are ready.\n");
}

async function fetchUser(provider: RemoteProvider, token: string): Promise<string> {
  const apiUrl = remoteApiUrl(provider);
  const res = await fetch(`${apiUrl}/user`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${provider} user: ${res.status}`);
  }

  const data = (await res.json()) as { login: string };
  return data.login;
}

// ─── Push to remote ─────────────────────────────────────────────
export async function pushManifest(kitYmlContent: string): Promise<void> {
  const config = await loadConfig();
  const profile = getActiveProfile(config);

  const token = await tokenForProvider(profile.provider);
  const lockContent = await readLocalLock();
  const kitPath = profile.path ?? "pi-depo.yml";

  if (profile.provider === "github" && profile.repo === "gists") {
    // Ask visibility on first push OR if gist was deleted (gist_id exists but will be recreated)
    if (profile.public === undefined) {
      const prompts = (await import("prompts")).default;
      const { isPublic } = await prompts({
        type: "confirm",
        name: "isPublic",
        message: "Make this gist public? (public = others can copy your config)",
        initial: false,
      }, { onCancel: () => process.exit(0) });
      profile.public = !!isPublic;
      await saveConfig(config);
    }
    const profileName = config.active_profile ?? "default";
    const gistId = await pushToGithubGist(token, kitPath, kitYmlContent, lockContent, profile.gist_id, profile.public ?? false, profileName);
    if (gistId && gistId !== profile.gist_id) {
      profile.gist_id = gistId;
      await saveConfig(config);
    }
  } else {
    switch (profile.provider) {
      case "github":
        await pushToGithub(token, profile.user, profile.repo, kitPath, profile.branch ?? "main", kitYmlContent, lockContent);
        break;
      case "codeberg":
        await pushToCodeberg(token, profile.user, profile.repo, kitPath, profile.branch ?? "main", kitYmlContent, lockContent);
        break;
    }
  }

  console.log("  ✅ Pushed to remote.\n");
}

// ─── Pull from remote ───────────────────────────────────────────
export async function pullManifest(): Promise<string> {
  const config = await loadConfig();
  const profile = getActiveProfile(config);
  const token = await tokenForProvider(profile.provider);
  const kitPath = profile.path ?? "pi-depo.yml";

  if (profile.provider === "github" && profile.repo === "gists") {
    // Auto-discover gist_id if missing (e.g. logged in before gist feature)
    if (!profile.gist_id) {
      const discovered = await findKitGist(token, kitPath);
      if (discovered) {
        profile.gist_id = discovered;
        await saveConfig(config);
      }
    }
    return await pullFromGithubGist(token, kitPath, profile.gist_id);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `token ${token}`;

  const url = remoteRawUrl(profile.provider, profile.user, profile.repo, kitPath, profile.branch ?? "main");
  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 404) throw new Error(`No kit.yml found at ${profile.provider}:${profile.user}/${profile.repo}/${kitPath}\n  Push your local manifest first: pd push`);
    throw new Error(`Failed to pull: ${res.status}`);
  }
  return await res.text();
}

// ─── Get active profile ─────────────────────────────────────────
function getActiveProfile(config: PkitConfig): NonNullable<PkitConfig["profiles"]>[string] & { provider: RemoteProvider; user: string; repo: string } {
  const name = config.active_profile ?? "default";
  const profile = config.profiles?.[name];
  if (!profile) {
    throw new Error(
      `No profile '${name}' configured.\n` +
      `  Run 'pd login' to auto-configure, or set up manually in ~/.pkit/config.yml`
    );
  }
  return profile as NonNullable<PkitConfig["profiles"]>[string] & { provider: RemoteProvider; user: string; repo: string };
}

// ─── GitHub push (via Contents API) ─────────────────────────────
// ─── GitHub Gists API ─────────────────────────────────────────────
async function findKitGist(token: string, kitPath: string): Promise<string | null> {
  const newName = kitPath.replace(/\//g, "_");
  const legacyName = "pi_kit.yml";
  try {
    const res = await fetch("https://api.github.com/gists?per_page=100", {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const gists = await res.json() as Array<{ id: string; files: Record<string, unknown> }>;
    return gists.find(g => "pi-depo.yml" in g.files || newName in g.files || legacyName in g.files)?.id ?? null;
  } catch { return null; }
}

async function pushToGithubGist(
  token: string,
  kitPath: string,
  kitYmlContent: string,
  lockContent: string | null,
  existingGistId?: string,
  isPublic = false,
  profileName = "default",
): Promise<string> {
  const files: Record<string, { content: string }> = { [kitPath]: { content: kitYmlContent } };
  if (lockContent) files["pi-depo.lock.json"] = { content: lockContent };
  const description = `pi-depo-${profileName}`;
  const headers = { Authorization: `token ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  if (existingGistId) {
    const res = await fetch(`https://api.github.com/gists/${existingGistId}`, {
      method: "PATCH", headers, body: JSON.stringify({ files, description }),
    });
    if (res.ok) return existingGistId;
    if (res.status !== 404) throw new Error(`Gist update failed: ${res.status}`);
    // 404 = gist was deleted - fall through to create a new one
  }
  const res = await fetch("https://api.github.com/gists", {
    method: "POST", headers,
    body: JSON.stringify({ files, public: isPublic, description }),
  });
  if (!res.ok) throw new Error(`Gist create failed: ${res.status}`);
  return (await res.json() as { id: string }).id;
}

async function pullFromGithubGist(token: string, kitPath: string, gistId?: string): Promise<string> {
  if (!gistId) throw new Error("No gist ID configured. Run 'pd push' first.");
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`Failed to pull gist: ${res.status}`);
  const data = await res.json() as { files: Record<string, { content: string }> };
  // Try new name first, then legacy names
  const file = data.files["pi-depo.yml"] ?? data.files["pi_kit.yml"] ?? data.files[kitPath.replace(/\//g, "_")];
  if (!file) throw new Error(`No pi-depo.yml found in gist ${gistId}`);
  return file.content;
}


async function pushToGithub(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch: string,
  content: string,
  lockContent: string | null
): Promise<void> {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;

  // Push kit.yml
  await pushFileToGithub(token, baseUrl, path, branch, content);

  // Push kit.lock.json alongside
  if (lockContent) {
    const lockPath = path.replace(/kit\.yml$/, "kit.lock.json");
    await pushFileToGithub(token, baseUrl, lockPath, branch, lockContent);
  }
}

async function pushFileToGithub(
  token: string,
  baseUrl: string,
  path: string,
  branch: string,
  content: string
): Promise<void> {
  const encodedPath = encodeURIComponent(path);
  const url = `${baseUrl}/${encodedPath}`;

  // Check if file exists to get SHA (required for update)
  let sha: string | undefined;
  const checkRes = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: "application/json" },
  });
  if (checkRes.ok) {
    const data = (await checkRes.json()) as { sha: string };
    sha = data.sha;
  }

  const body: Record<string, unknown> = {
    message: `pd: update ${path}`,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`GitHub push failed for ${path}: ${res.status}`);
  }
}

// ─── Codeberg push (Gitea API, same as GitHub Contents) ─────────
async function pushToCodeberg(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch: string,
  content: string,
  lockContent: string | null
): Promise<void> {
  const baseUrl = `https://codeberg.org/api/v1/repos/${owner}/${repo}/contents`;

  await pushFileToCodeberg(token, baseUrl, path, branch, content);

  if (lockContent) {
    const lockPath = path.replace(/kit\.yml$/, "kit.lock.json");
    await pushFileToCodeberg(token, baseUrl, lockPath, branch, lockContent);
  }
}

async function pushFileToCodeberg(
  token: string,
  baseUrl: string,
  path: string,
  branch: string,
  content: string
): Promise<void> {
  const url = `${baseUrl}/${path}`;

  let sha: string | undefined;
  const checkRes = await fetch(url, {
    headers: { Authorization: `token ${token}` },
  });
  if (checkRes.ok) {
    const data = (await checkRes.json()) as { sha: string };
    sha = data.sha;
  }

  const body: Record<string, unknown> = {
    message: `pd: update ${path}`,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Codeberg push failed for ${path}: ${res.status}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────
async function readLocalLock(): Promise<string | null> {
  const lockPath = join(process.cwd(), "kit.lock.json");
  if (!existsSync(lockPath)) return null;
  return await readFile(lockPath, "utf-8");
}

// ─── Profile management ─────────────────────────────────────────
export async function listProfiles(): Promise<void> {
  const config = await loadConfig();
  const profiles = config.profiles ?? {};
  const active = config.active_profile ?? "default";

  if (Object.keys(profiles).length === 0) {
    console.log("  No profiles configured. Run 'pd login' to create one.");
    return;
  }

  for (const [name, profile] of Object.entries(profiles)) {
    const marker = name === active ? "→" : " ";
    console.log(`  ${marker} ${name}: ${profile.provider}:${profile.user}/${profile.repo}/${profile.path ?? "pi-depo.yml"}`);
  }
}

export async function switchProfile(name: string): Promise<void> {
  const config = await loadConfig();
  if (!config.profiles?.[name]) {
    throw new Error(`Profile '${name}' not found. Available: ${Object.keys(config.profiles ?? {}).join(", ")}`);
  }
  config.active_profile = name;
  await saveConfig(config);
  console.log(`  Switched to profile: ${name}`);
}
