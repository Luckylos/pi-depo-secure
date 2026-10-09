import { access, chmod, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";
import { collectSnapshot, diffSnapshots, applySnapshot, type SnapshotDiff } from "./snapshot.js";
import { decryptSnapshot, encryptSnapshot, sha256, type EncryptedSnapshot, type SnapshotEntry } from "./crypto.js";
import { GistClient, SYNC_CONFIG_FILE, SYNC_MANIFEST_FILE, type GistResponse } from "./gist-remote.js";
import { tokenForProvider } from "./remote.js";
import { kitYmlPath, loadConfig, saveConfig } from "./config.js";
import { pullManifest, pushManifest } from "./remote.js";
import { bootstrapManifestFromPi, status as packageStatusCommand, sync as syncPackages } from "./sync.js";
import { runCommand } from "./process.js";
import type { PkitConfig } from "./types.js";

export const SYNC_SETTINGS_FILE = "pi-gist-sync.json";
export const DEFAULT_INCLUDE = [
  "settings.json",
  "models.json",
  "auth.json",
  "APPEND_SYSTEM.md",
  "mcp-onboarding.json",
  "models-store.json",
  "orchestrator-mode.json",
  "pi-fff.json",
  "pi-statusline.json",
  "sol-pi.json",
  "subagents.json",
  "subagents-worktrees.json",
  "mcp.json",
  "agents",
  "skills",
  "prompts",
  "themes",
  "extensions",
];
export const DEFAULT_EXCLUDE: string[] = [];
const MAX_GIST_PAYLOAD_BYTES = 8 * 1024 * 1024;

export interface SyncSettings {
  schemaVersion: 1;
  gistId?: string;
  profile: string;
  description: string;
  public: false;
  include: string[];
  exclude: string[];
  prune: boolean;
  piDepo: { enabled: boolean; autoPush: boolean; autoSync: boolean };
}

export interface SyncManifest {
  schemaVersion: 1;
  tool: "pi-depo-secure";
  generatedAt: string;
  profile: string;
  fileCount: number;
  payloadBytes: number;
  payloadSha256: string;
  encryption: { algorithm: "aes-256-gcm"; kdf: "scrypt" };
  packageSync: { provider: "pi-depo"; enabled: boolean };
}

export interface SyncResult {
  gistId: string;
  manifest: SyncManifest;
  diff?: SnapshotDiff;
  backupPath?: string;
}

export interface ConfigPreview {
  gistId?: string;
  profile: string;
  fileCount: number;
  plaintextBytes: number;
  payloadBytes: number;
  paths: string[];
  manifest: SyncManifest;
}

export interface SetupResult extends SyncResult {
  settings: SyncSettings;
  created: boolean;
  reused: boolean;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface GistClientLike {
  get(id: string): Promise<GistResponse>;
  create(description: string, isPublic: boolean, files: Record<string, string>): Promise<GistResponse>;
  update(id: string, files: Record<string, string>): Promise<GistResponse>;
  list?(): Promise<GistResponse[]>;
}

export interface PackageConfigStore {
  load(): Promise<PkitConfig>;
  save(config: PkitConfig): Promise<void>;
}

export type PackageSetup = (gistId: string, profile: string, packageConfig?: PackageConfigStore) => Promise<void>;

const defaultPackageConfigStore: PackageConfigStore = { load: loadConfig, save: saveConfig };

export function ensurePiDepoProfile(config: PkitConfig, gistId: string, profileName = "default"): { config: PkitConfig; linked: boolean; changed: boolean } {
  const next: PkitConfig = { ...config };
  delete next.auth;
  const profiles = { ...(config.profiles ?? {}) };
  const activeProfile = config.active_profile ?? profileName;
  const existing = profiles[activeProfile];

  if (!existing) {
    profiles[activeProfile] = { provider: "github", user: "", repo: "gists", path: "pi-depo.yml", gist_id: gistId, public: false };
    next.active_profile = activeProfile;
    next.profiles = profiles;
    return { config: next, linked: true, changed: true };
  }

  if (existing.provider !== "github" || existing.repo !== "gists") return { config: next, linked: false, changed: false };
  if (existing.gist_id && existing.gist_id !== gistId) return { config: next, linked: false, changed: false };
  if (existing.gist_id === gistId) return { config: next, linked: true, changed: false };

  profiles[activeProfile] = { ...existing, gist_id: gistId, public: existing.public ?? false };
  next.active_profile = activeProfile;
  next.profiles = profiles;
  return { config: next, linked: true, changed: true };
}

export function defaultSyncSettings(): SyncSettings {
  return { schemaVersion: 1, profile: "default", description: "pi-gist-sync-default", public: false, include: [...DEFAULT_INCLUDE], exclude: [...DEFAULT_EXCLUDE], prune: false, piDepo: { enabled: true, autoPush: false, autoSync: false } };
}

function settingsPath(agentDir: string): string { return join(agentDir, SYNC_SETTINGS_FILE); }

function validateSettings(settings: SyncSettings): SyncSettings {
  if (settings.schemaVersion !== 1) throw new Error("Unsupported pi-gist-sync settings version");
  if (settings.public !== false) throw new Error("Public Gists are disabled for encrypted configuration sync");
  if (!settings.profile || !/^[A-Za-z0-9._-]+$/.test(settings.profile)) throw new Error("Invalid sync profile");
  if (!settings.description || settings.description.length > 256) throw new Error("Invalid Gist description");
  if (!Array.isArray(settings.include) || settings.include.length === 0) throw new Error("Sync include list cannot be empty");
  if (!Array.isArray(settings.exclude)) throw new Error("Sync exclude list must be an array");
  for (const path of [...settings.include, ...settings.exclude]) {
    if (!path || path.startsWith("/") || path.startsWith("\\") || path.split("/").includes("..")) throw new Error("Invalid sync path: " + path);
  }
  return settings;
}

export async function loadSyncSettings(agentDir: string): Promise<SyncSettings> {
  try {
    const value = JSON.parse(await readFile(settingsPath(agentDir), "utf8")) as Partial<SyncSettings>;
    const defaults = defaultSyncSettings();
    return validateSettings({ ...defaults, ...value, piDepo: { ...defaults.piDepo, ...(value.piDepo ?? {}) }, include: value.include ?? defaults.include, exclude: value.exclude ?? defaults.exclude, public: false, schemaVersion: 1 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultSyncSettings();
    if (error instanceof SyntaxError) throw new Error("Invalid pi-gist-sync settings JSON");
    throw error;
  }
}

export async function saveSyncSettings(agentDir: string, settings: SyncSettings): Promise<void> {
  const safe = validateSettings(settings);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const temporary = settingsPath(agentDir) + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
  await writeFile(temporary, JSON.stringify(safe, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, settingsPath(agentDir));
  await chmod(settingsPath(agentDir), 0o600);
}

function contentFromGist(gist: GistResponse, filename: string): string {
  const file = gist.files?.[filename];
  if (!file || file.truncated || typeof file.content !== "string") throw new Error("Gist is missing readable " + filename);
  return file.content;
}

function parseManifest(content: string): SyncManifest {
  let parsed: SyncManifest;
  try { parsed = JSON.parse(content) as SyncManifest; } catch { throw new Error("Invalid encrypted sync manifest JSON"); }
  if (parsed.schemaVersion !== 1 || parsed.tool !== "pi-depo-secure" || parsed.encryption?.algorithm !== "aes-256-gcm" || parsed.encryption?.kdf !== "scrypt") throw new Error("Unsupported sync manifest");
  if (!Number.isInteger(parsed.fileCount) || parsed.fileCount < 0 || !Number.isInteger(parsed.payloadBytes) || parsed.payloadBytes <= 0 || !/^[0-9a-f]{64}$/.test(parsed.payloadSha256)) throw new Error("Invalid sync manifest");
  return parsed;
}

function parseEnvelope(content: string): EncryptedSnapshot {
  try { return JSON.parse(content) as EncryptedSnapshot; } catch { throw new Error("Invalid encrypted sync payload JSON"); }
}

function assertPrivateGist(gist: GistResponse): void {
  if (gist.public !== false) throw new Error("Configuration sync refuses to use a public or unidentified Gist");
}

async function resolveClient(client?: GistClientLike): Promise<GistClientLike> {
  if (client) return client;
  return new GistClient(await tokenForProvider("github"));
}

export async function findMatchingGists(client: GistClientLike, settings: SyncSettings): Promise<GistResponse[]> {
  if (!client.list) return [];
  const gists = await client.list();
  const owned = (gist: GistResponse): boolean => Boolean(gist.files?.[SYNC_MANIFEST_FILE] || gist.files?.[SYNC_CONFIG_FILE]);
  return gists.filter((gist) => gist.public === false && (gist.description === settings.description || owned(gist)));
}

export async function findMatchingGist(client: GistClientLike, settings: SyncSettings): Promise<GistResponse | undefined> {
  return (await findMatchingGists(client, settings))[0];
}

export async function discoverSyncGists(options: { agentDir: string; client?: GistClientLike; settings?: SyncSettings }): Promise<GistResponse[]> {
  const settings = await effectiveSettings(options.agentDir, options.settings);
  return findMatchingGists(options.client ?? await resolveClient(), settings);
}

async function effectiveSettings(agentDir: string, provided?: SyncSettings): Promise<SyncSettings> {
  const settings = validateSettings(provided ?? await loadSyncSettings(agentDir));
  if (settings.gistId) return settings;
  try {
    const pkit = await loadConfig();
    const profile = pkit.profiles?.[pkit.active_profile ?? "default"];
    if (profile?.provider === "github" && profile.repo === "gists" && profile.gist_id) return { ...settings, gistId: profile.gist_id };
  } catch {
    // A clean Pi installation may not have pi-depo's own config yet.
  }
  return settings;
}


async function initializePiDepoProfile(gistId: string, profileName: string, packageConfig: PackageConfigStore = defaultPackageConfigStore): Promise<boolean> {
  try {
    const result = ensurePiDepoProfile(await packageConfig.load(), gistId, profileName);
    if (result.changed) await packageConfig.save(result.config);
    return result.linked;
  } catch {
    return false;
  }
}

async function initializePackageLayer(gistId: string, profile: string, packageConfig: PackageConfigStore = defaultPackageConfigStore): Promise<void> {
  if (!await initializePiDepoProfile(gistId, profile, packageConfig)) return;
  await bootstrapManifestFromPi();
  await pushManifest(await readFile(kitYmlPath(), "utf8"));
}

function packageCliPath(): string {
  return process.env.PI_DEPO_CLI_PATH ?? fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
}

async function prepareExplicitPackageOperation(action: "push" | "pull" | "sync", agentDir?: string): Promise<void> {
  if (!agentDir) return;
  const settings = await loadSyncSettings(agentDir);
  if (!settings.gistId) return;
  if (!await initializePiDepoProfile(settings.gistId, settings.profile)) throw new Error("Could not link pi-depo to the configured private Gist");
  if (action === "push") {
    try { await access(kitYmlPath()); }
    catch { await bootstrapManifestFromPi(); }
  }
}

async function packageAction(action: "status" | "push" | "pull" | "sync", agentDir?: string): Promise<{ available: boolean; exitCode: number; output: string }> {
  if (action !== "status") await prepareExplicitPackageOperation(action, agentDir);
  const cli = packageCliPath();
  try {
    await access(cli);
    const env = { ...process.env, ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}) };
    const result = await runCommand(process.execPath, [cli, action], { timeoutMs: 120_000, env });
    if (result.errorCode !== "ENOENT") return { available: true, exitCode: result.exitCode, output: (result.stdout.toString("utf8") + result.stderr.toString("utf8")).trim() };
  } catch {
    // Git-installed source packages may not contain generated dist/cli.mjs.
  }
  return packageSourceAction(action, agentDir);
}

async function packageSourceAction(action: "status" | "push" | "pull" | "sync", agentDir?: string): Promise<{ available: boolean; exitCode: number; output: string }> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (agentDir) process.env.PI_CODING_AGENT_DIR = agentDir;
  const output: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => output.push(args.map(String).join(" "));
  try {
    if (action === "status") await packageStatusCommand();
    else if (action === "push") await pushManifest(await readFile(kitYmlPath(), "utf8"));
    else if (action === "pull") await writeFile(kitYmlPath(), await pullManifest(), "utf8");
    else await syncPackages(false, { allowUpdates: process.env.PI_DEPO_ALLOW_UPDATES === "1" });
    return { available: true, exitCode: 0, output: output.join("\n").trim() };
  } catch (error) {
    output.push(error instanceof Error ? error.message : "pi-depo package operation failed");
    return { available: true, exitCode: 1, output: output.join("\n").trim() };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

export async function packageStatus(agentDir?: string): Promise<{ available: boolean; exitCode: number; output: string }> { return packageAction("status", agentDir); }
export async function packagePush(agentDir?: string): Promise<{ available: boolean; exitCode: number; output: string }> { return packageAction("push", agentDir); }
export async function packagePull(syncPackages = false, agentDir?: string): Promise<{ available: boolean; exitCode: number; output: string }> { return packageAction(syncPackages ? "sync" : "pull", agentDir); }

function manifestFromPayload(settings: SyncSettings, entries: SnapshotEntry[], payload: string): SyncManifest {
  return { schemaVersion: 1, tool: "pi-depo-secure", generatedAt: new Date().toISOString(), profile: settings.profile, fileCount: entries.length, payloadBytes: Buffer.byteLength(payload), payloadSha256: sha256(Buffer.from(payload)), encryption: { algorithm: "aes-256-gcm", kdf: "scrypt" }, packageSync: { provider: "pi-depo", enabled: settings.piDepo.enabled } };
}

export async function previewConfig(options: { agentDir: string; passphrase: string; client?: GistClientLike; settings?: SyncSettings; createNew?: boolean }): Promise<ConfigPreview> {
  const settings = options.createNew ? validateSettings(options.settings ?? await loadSyncSettings(options.agentDir)) : await effectiveSettings(options.agentDir, options.settings);
  const entries = await collectSnapshot(options.agentDir, settings.include, settings.exclude);
  const encrypted = await encryptSnapshot(entries, options.passphrase);
  const payload = JSON.stringify(encrypted);
  if (Buffer.byteLength(payload) > MAX_GIST_PAYLOAD_BYTES) throw new Error("Encrypted configuration exceeds GitHub Gist size limit");
  const manifest = manifestFromPayload(settings, entries, payload);
  return { gistId: settings.gistId, profile: settings.profile, fileCount: entries.length, plaintextBytes: entries.reduce((total, entry) => total + Buffer.byteLength(entry.contentBase64, "base64"), 0), payloadBytes: manifest.payloadBytes, paths: entries.map((entry) => entry.path), manifest };
}

async function backupSnapshot(agentDir: string, entries: SnapshotEntry[], passphrase: string): Promise<string> {
  const root = join(agentDir, "backups", "pi-gist-sync", new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const encrypted = await encryptSnapshot(entries, passphrase);
  const path = join(root, SYNC_CONFIG_FILE);
  await writeFile(path, JSON.stringify(encrypted, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  return root;
}

export async function listBackups(agentDir: string): Promise<string[]> {
  const root = join(resolve(agentDir), "backups", "pi-gist-sync");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRemoteSnapshot(client: GistClientLike, settings: SyncSettings, passphrase: string): Promise<{ manifest: SyncManifest; entries: SnapshotEntry[] }> {
  if (!settings.gistId) throw new Error("No Gist ID configured. Run setup or push first");
  const gist = await client.get(settings.gistId);
  assertPrivateGist(gist);
  const manifest = parseManifest(contentFromGist(gist, SYNC_MANIFEST_FILE));
  const payload = contentFromGist(gist, SYNC_CONFIG_FILE);
  if (Buffer.byteLength(payload) !== manifest.payloadBytes || sha256(Buffer.from(payload)) !== manifest.payloadSha256) throw new Error("Encrypted sync payload hash mismatch");
  const entries = await decryptSnapshot(parseEnvelope(payload), passphrase);
  if (entries.length !== manifest.fileCount) throw new Error("Encrypted sync payload file count mismatch");
  return { manifest, entries };
}

export async function pushConfig(options: { agentDir: string; passphrase: string; client?: GistClientLike; settings?: SyncSettings; syncPackages?: boolean; packageConfig?: PackageConfigStore; createNew?: boolean }): Promise<SyncResult> {
  const initialSettings = validateSettings(options.settings ?? await loadSyncSettings(options.agentDir));
  if (options.syncPackages && initialSettings.piDepo.enabled) {
    const packageResult = await packagePush(options.agentDir);
    if (!packageResult.available || packageResult.exitCode !== 0) throw new Error("pi-depo package push failed");
  }
  const client = await resolveClient(options.client);
  const settings = options.createNew ? initialSettings : await effectiveSettings(options.agentDir, initialSettings);
  if (!settings.gistId) {
    const matches = await findMatchingGists(client, settings);
    if (!options.createNew) {
      if (matches.length > 1) throw new Error("Multiple matching private Gists found; run setup with an explicit target");
      if (matches.length === 1) throw new Error("Existing private Gist found; run gist-sync setup to restore it or use --create");
    }
  }
  const entries = await collectSnapshot(options.agentDir, settings.include, settings.exclude);
  const encrypted = await encryptSnapshot(entries, options.passphrase);
  const payload = JSON.stringify(encrypted);
  if (Buffer.byteLength(payload) > MAX_GIST_PAYLOAD_BYTES) throw new Error("Encrypted configuration exceeds GitHub Gist size limit");
  const manifest = manifestFromPayload(settings, entries, payload);
  let result: GistResponse;
  if (settings.gistId) {
    const existing = await client.get(settings.gistId);
    assertPrivateGist(existing);
    result = await client.update(settings.gistId, { [SYNC_MANIFEST_FILE]: JSON.stringify(manifest, null, 2) + "\n", [SYNC_CONFIG_FILE]: payload });
  } else {
    result = await client.create(settings.description, false, { [SYNC_MANIFEST_FILE]: JSON.stringify(manifest, null, 2) + "\n", [SYNC_CONFIG_FILE]: payload });
  }
  if (!result.id) throw new Error("GitHub did not return a Gist ID");
  await saveSyncSettings(options.agentDir, { ...settings, gistId: result.id });
  return { gistId: result.id, manifest };
}

export async function setupSync(options: { agentDir: string; passphrase: string; client?: GistClientLike; settings?: SyncSettings; profile?: string; gistId?: string; syncPackages?: boolean; packageConfig?: PackageConfigStore; packageSetup?: PackageSetup; createNew?: boolean }): Promise<SetupResult> {
  const current = validateSettings(options.settings ?? await loadSyncSettings(options.agentDir));
  const settings = validateSettings({ ...current, ...(options.profile ? { profile: options.profile, description: "pi-gist-sync-" + options.profile } : {}), ...(options.gistId ? { gistId: options.gistId } : {}) });
  const hadExistingGist = Boolean(settings.gistId);
  const client = await resolveClient(options.client);
  const result = await pushConfig({ agentDir: options.agentDir, passphrase: options.passphrase, client, settings, syncPackages: options.syncPackages, packageConfig: options.packageConfig, createNew: options.createNew });
  const packageConfig = options.packageConfig ?? defaultPackageConfigStore;
  if (options.syncPackages && settings.piDepo.enabled) {
    if (options.packageSetup) {
      if (await initializePiDepoProfile(result.gistId, settings.profile, packageConfig)) await options.packageSetup(result.gistId, settings.profile, packageConfig);
    } else {
      await initializePackageLayer(result.gistId, settings.profile, packageConfig);
    }
  }
  return { ...result, settings: { ...settings, gistId: result.gistId }, created: !hadExistingGist, reused: hadExistingGist };
}

export async function restoreExistingGist(options: { agentDir: string; passphrase: string; gistId: string; client?: GistClientLike; settings?: SyncSettings; prune?: boolean }): Promise<SyncResult> {
  const current = validateSettings(options.settings ?? await loadSyncSettings(options.agentDir));
  const settings = validateSettings({ ...current, gistId: options.gistId });
  return fetchConfig({ agentDir: options.agentDir, passphrase: options.passphrase, client: options.client, settings, prune: options.prune });
}

export async function fetchConfig(options: { agentDir: string; passphrase: string; client?: GistClientLike; settings?: SyncSettings; prune?: boolean; syncPackages?: boolean }): Promise<SyncResult> {
  const settings = await effectiveSettings(options.agentDir, options.settings);
  const client = await resolveClient(options.client);
  const remote = await readRemoteSnapshot(client, settings, options.passphrase);
  const current = await collectSnapshot(options.agentDir, settings.include, settings.exclude);
  const diff = diffSnapshots(current, remote.entries);
  const backupPath = await backupSnapshot(options.agentDir, current, options.passphrase);
  try {
    await applySnapshot(options.agentDir, remote.entries, { prune: options.prune ?? settings.prune, managedPaths: settings.include });
  } catch (error) {
    try { await applySnapshot(options.agentDir, current, { prune: true, managedPaths: settings.include }); } catch { throw new Error("Configuration restore failed and rollback also failed"); }
    throw error;
  }
  try {
    await saveSyncSettings(options.agentDir, settings);
    if (options.syncPackages && settings.piDepo.enabled) {
      const packageResult = await packagePull(true, options.agentDir);
      if (!packageResult.available || packageResult.exitCode !== 0) throw new Error("pi-depo package sync failed after configuration restore");
    }
  } catch (error) {
    try { await applySnapshot(options.agentDir, current, { prune: true, managedPaths: settings.include }); }
    catch { throw new Error("Configuration restore succeeded but package sync failed and rollback also failed"); }
    throw error;
  }
  return { gistId: settings.gistId!, manifest: remote.manifest, diff, backupPath };
}

export async function syncStatus(options: { agentDir: string; client?: GistClientLike; settings?: SyncSettings }): Promise<{ configured: boolean; gistId?: string; manifest?: SyncManifest; packageStatus?: { available: boolean; exitCode: number; output: string }; backupCount: number }> {
  const settings = await effectiveSettings(options.agentDir, options.settings);
  const backupCount = (await listBackups(options.agentDir)).length;
  if (!settings.gistId) return { configured: false, backupCount };
  const gist = await (await resolveClient(options.client)).get(settings.gistId);
  assertPrivateGist(gist);
  const manifest = parseManifest(contentFromGist(gist, SYNC_MANIFEST_FILE));
  const packageStatusResult = settings.piDepo.enabled ? await packageStatus(options.agentDir) : undefined;
  return { configured: true, gistId: settings.gistId, manifest, packageStatus: packageStatusResult, backupCount };
}

export async function initSync(options: { agentDir: string; gistId?: string; profile?: string }): Promise<SyncSettings> {
  const current = await loadSyncSettings(options.agentDir);
  const next = validateSettings({ ...current, ...(options.gistId ? { gistId: options.gistId } : {}), ...(options.profile ? { profile: options.profile, description: "pi-gist-sync-" + options.profile } : {}) });
  await saveSyncSettings(options.agentDir, next);
  return next;
}

export async function diffConfig(options: { agentDir: string; passphrase: string; client?: GistClientLike; settings?: SyncSettings }): Promise<{ gistId: string; manifest: SyncManifest; diff: SnapshotDiff }> {
  const settings = await effectiveSettings(options.agentDir, options.settings);
  const client = await resolveClient(options.client);
  const remote = await readRemoteSnapshot(client, settings, options.passphrase);
  const current = await collectSnapshot(options.agentDir, settings.include, settings.exclude);
  return { gistId: settings.gistId!, manifest: remote.manifest, diff: diffSnapshots(current, remote.entries) };
}

export async function doctorSync(options: { agentDir: string; client?: GistClientLike; settings?: SyncSettings; passphrase?: string }): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  let settings: SyncSettings;
  try {
    settings = await effectiveSettings(options.agentDir, options.settings);
    checks.push({ name: "local-settings", ok: true, detail: "local sync settings are valid" });
  } catch (error) {
    checks.push({ name: "local-settings", ok: false, detail: error instanceof Error ? error.message : "invalid local settings" });
    return { ok: false, checks };
  }
  let client: GistClientLike | undefined = options.client;
  if (client) checks.push({ name: "github-auth", ok: true, detail: "injected Gist client available" });
  else {
    try { await tokenForProvider("github"); checks.push({ name: "github-auth", ok: true, detail: "GitHub authentication is available" }); }
    catch { checks.push({ name: "github-auth", ok: false, detail: "GitHub authentication is unavailable" }); }
  }
  const backups = await listBackups(options.agentDir);
  checks.push({ name: "local-backups", ok: true, detail: backups.length + " local backup(s) available" });
  if (!settings.gistId) {
    checks.push({ name: "gist-configured", ok: false, detail: "No private Gist is configured; run gist-sync setup" });
  } else {
    try {
      client ??= await resolveClient(options.client);
      const gist = await client.get(settings.gistId);
      assertPrivateGist(gist);
      const manifest = parseManifest(contentFromGist(gist, SYNC_MANIFEST_FILE));
      const payload = contentFromGist(gist, SYNC_CONFIG_FILE);
      const validHash = Buffer.byteLength(payload) === manifest.payloadBytes && sha256(Buffer.from(payload)) === manifest.payloadSha256;
      checks.push({ name: "gist-integrity", ok: validHash, detail: validHash ? "private Gist manifest and payload hash are valid" : "encrypted payload hash mismatch" });
      if (options.passphrase && validHash) {
        try {
          const entries = await decryptSnapshot(parseEnvelope(payload), options.passphrase);
          const validCount = entries.length === manifest.fileCount;
          checks.push({ name: "decryption", ok: validCount, detail: validCount ? "encrypted payload decrypts successfully" : "encrypted payload file count mismatch" });
        } catch { checks.push({ name: "decryption", ok: false, detail: "encrypted payload could not be decrypted" }); }
      }
    } catch (error) {
      checks.push({ name: "gist-integrity", ok: false, detail: error instanceof Error ? error.message : "Gist validation failed" });
    }
  }
  if (settings.piDepo.enabled) {
    const packageStatusResult = await packageStatus(options.agentDir);
    const packageOk = packageStatusResult.available && packageStatusResult.exitCode === 0;
    checks.push({ name: "package-cli", ok: packageOk, detail: packageOk ? "bundled pi-depo CLI is available" : packageStatusResult.output || "pi-depo package status failed" });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export async function restoreBackup(options: { agentDir: string; backupPath: string; passphrase: string; prune?: boolean }): Promise<{ backupPath: string }> {
  const root = resolve(options.agentDir);
  const backupRoot = resolve(options.backupPath);
  const allowedRoot = resolve(join(root, "backups", "pi-gist-sync"));
  const relativeBackup = relative(allowedRoot, backupRoot);
  if (relativeBackup === ".." || relativeBackup.startsWith(".." + "/") || isAbsolute(relativeBackup)) throw new Error("Backup path is outside the Pi backup directory");
  let safeBackupRoot: string;
  try { safeBackupRoot = await realpath(backupRoot); } catch { throw new Error("Backup directory does not exist"); }
  const resolvedRelative = relative(allowedRoot, safeBackupRoot);
  if (resolvedRelative === ".." || resolvedRelative.startsWith(".." + "/") || isAbsolute(resolvedRelative)) throw new Error("Backup path resolves outside the Pi backup directory");
  let encrypted: EncryptedSnapshot;
  try { encrypted = JSON.parse(await readFile(join(safeBackupRoot, SYNC_CONFIG_FILE), "utf8")) as EncryptedSnapshot; } catch { throw new Error("Invalid backup payload JSON"); }
  const entries = await decryptSnapshot(encrypted, options.passphrase);
  const settings = await loadSyncSettings(root);
  const current = await collectSnapshot(root, settings.include, settings.exclude);
  try {
    await applySnapshot(root, entries, { prune: options.prune ?? settings.prune, managedPaths: settings.include });
  } catch (error) {
    try { await applySnapshot(root, current, { prune: true, managedPaths: settings.include }); } catch { throw new Error("Backup restore failed and rollback also failed"); }
    throw error;
  }
  return { backupPath: safeBackupRoot };
}
