import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { KitLock, PkitConfig, RemoteProvider } from "./types.js";
import yaml from "js-yaml";

// ─── Paths ──────────────────────────────────────────────────────
export const PKIT_DIR = join(homedir(), ".pkit");
export const CONFIG_PATH = join(PKIT_DIR, "config.yml");
export const LOCK_FILENAME = "kit.lock.json";

export function kitYmlPath(cwd?: string): string {
  return join(cwd ?? process.cwd(), "kit.yml");
}

export function lockPath(cwd?: string): string {
  return join(cwd ?? process.cwd(), LOCK_FILENAME);
}

// ─── Config I/O ─────────────────────────────────────────────────
export function sanitizeConfig(config: PkitConfig): PkitConfig {
  const safeConfig = { ...config };
  delete safeConfig.auth;
  return safeConfig;
}
export async function loadConfig(): Promise<PkitConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  const content = await readFile(CONFIG_PATH, "utf-8");
  let parsed: PkitConfig | undefined;
  try {
    parsed = yaml.load(content) as PkitConfig | undefined;
  } catch {
    throw new Error("Invalid pi-depo config YAML");
  }
  if (!parsed || typeof parsed !== "object") return {};
  delete parsed.auth;
  return parsed;
}

export async function saveConfig(config: PkitConfig): Promise<void> {
  if (!existsSync(PKIT_DIR)) {
    await mkdir(PKIT_DIR, { recursive: true });
  }
  await writeFile(CONFIG_PATH, yaml.dump(sanitizeConfig(config), { lineWidth: 120, noRefs: true }), "utf-8");
}

// ─── Lock I/O ───────────────────────────────────────────────────
export async function loadLock(cwd?: string): Promise<KitLock | null> {
  const path = lockPath(cwd);
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf-8");
  try {
    return JSON.parse(content) as KitLock;
  } catch {
    throw new Error("Invalid kit lock JSON");
  }
}

export async function saveLock(lock: KitLock, cwd?: string): Promise<void> {
  await writeFile(lockPath(cwd), JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

// ─── Template vars ──────────────────────────────────────────────
export function templateVars(): Record<string, string> {
  return {
    home: homedir(),
    user: process.env.USER ?? "unknown",
    cwd: process.cwd(),
  };
}

// ─── Remote URL builder ─────────────────────────────────────────
export function remoteRawUrl(
  provider: RemoteProvider,
  user: string,
  repo: string,
  path: string,
  branch: string = "main"
): string {
  switch (provider) {
    case "github":
      return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path}`;
    case "codeberg":
      return `https://codeberg.org/${user}/${repo}/raw/branch/${branch}/${path}`;
  }
}

export function remoteApiUrl(provider: RemoteProvider): string {
  switch (provider) {
    case "github":
      return "https://api.github.com";
    case "codeberg":
      return "https://codeberg.org/api/v1";
  }
}

// ─── Pi paths ───────────────────────────────────────────────────
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function piSettingsPath(): string {
  return join(piAgentDir(), "settings.json");
}

export function piMcpPath(): string {
  return join(piAgentDir(), "mcp.json");
}

export function piSkillsDir(): string {
  return join(piAgentDir(), "skills");
}

export function piExtensionsDir(): string {
  return join(piAgentDir(), "extensions");
}
