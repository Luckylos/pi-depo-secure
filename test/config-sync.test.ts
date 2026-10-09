
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INCLUDE, discoverSyncGists, doctorSync, ensurePiDepoProfile, fetchConfig, previewConfig, pushConfig, restoreBackup, restoreExistingGist, setupSync, type SyncSettings } from "../src/config-sync.js";
import type { GistResponse } from "../src/gist-remote.js";

class MemoryGist {
  value: GistResponse | undefined;
  async list(): Promise<GistResponse[]> { return this.value ? [this.value] : []; }
  async create(description: string, isPublic: boolean, files: Record<string, string>): Promise<GistResponse> {
    this.value = { id: "gist-1", description, public: isPublic, files: Object.fromEntries(Object.entries(files).map(([filename, content]) => [filename, { filename, content }])) };
    return this.value;
  }
  async update(id: string, files: Record<string, string>): Promise<GistResponse> {
    if (!this.value || this.value.id !== id) throw new Error("missing gist");
    this.value = { ...this.value, files: { ...this.value.files, ...Object.fromEntries(Object.entries(files).map(([filename, content]) => [filename, { filename, content }])) } };
    return this.value;
  }
  async get(id: string): Promise<GistResponse> { if (!this.value || this.value.id !== id) throw new Error("missing gist"); return this.value; }
}

class MultiMemoryGist {
  value: GistResponse[] = [];
  async list(): Promise<GistResponse[]> { return this.value; }
  async create(description: string, isPublic: boolean, files: Record<string, string>): Promise<GistResponse> {
    const gist = { id: `gist-${this.value.length + 1}`, description, public: isPublic, files: Object.fromEntries(Object.entries(files).map(([filename, content]) => [filename, { filename, content }])) };
    this.value.push(gist);
    return gist;
  }
  async update(id: string, files: Record<string, string>): Promise<GistResponse> {
    const current = this.value.find((gist) => gist.id === id);
    if (!current) throw new Error("missing gist");
    const updated = { ...current, files: { ...current.files, ...Object.fromEntries(Object.entries(files).map(([filename, content]) => [filename, { filename, content }])) } };
    this.value = this.value.map((gist) => gist.id === id ? updated : gist);
    return updated;
  }
  async get(id: string): Promise<GistResponse> {
    const current = this.value.find((gist) => gist.id === id);
    if (!current) throw new Error("missing gist");
    return current;
  }
}

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "pi-gist-sync-test-")); roots.push(value); return value; }
const settings = (gistId?: string): SyncSettings => ({ schemaVersion: 1, gistId, profile: "test", description: "pi-gist-sync-test", public: false, include: ["settings.json", "models.json", "agents"], exclude: [], prune: false, piDepo: { enabled: false, autoPush: false, autoSync: false } });
afterEach(async () => {
  delete process.env.PI_DEPO_CLI_PATH;
  await rm(join(homedir(), ".pkit"), { recursive: true, force: true });
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const passphrase = "correct horse battery staple";
const isolatedPackageConfig = { load: async () => ({}), save: async () => {} };

describe("encrypted Gist configuration sync", () => {
  it("creates a private pi-depo Gist profile without persisting credentials", () => {
    const result = ensurePiDepoProfile({}, "gist-1", "default");
    expect(result.linked).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.config.profiles?.default).toMatchObject({ provider: "github", repo: "gists", gist_id: "gist-1", public: false });
    expect(result.config.profiles?.default).not.toHaveProperty("auth");
  });

  it("keeps package-layer writes out of configuration setup", async () => {
    const source = await root();
    await writeFile(join(source, "settings.json"), "source");
    const client = new MemoryGist();
    const packageCalls: string[] = [];
    const packageConfig = { load: async () => ({}), save: async () => { packageCalls.push("profile"); } };
    await setupSync({
      agentDir: source,
      passphrase,
      client,
      settings: settings(),
      packageConfig,
      packageSetup: async (gistId, profile) => { packageCalls.push("setup:" + gistId + ":" + profile); },
    });

    expect(packageCalls).toEqual([]);
  });

  it("allows package-layer initialization only when explicitly requested", async () => {
    const source = await root();
    await writeFile(join(source, "settings.json"), "source");
    const client = new MemoryGist();
    const packageCalls: string[] = [];
    const packageConfig = { load: async () => ({}), save: async () => { packageCalls.push("profile"); } };

    const fakeCli = join(source, "successful-pd.mjs");
    await writeFile(fakeCli, "process.exit(0)");
    process.env.PI_DEPO_CLI_PATH = fakeCli;

    await setupSync({
      agentDir: source,
      passphrase,
      client,
      settings: { ...settings(), piDepo: { ...settings().piDepo, enabled: true } },
      syncPackages: true,
      packageConfig,
      packageSetup: async (gistId, profile) => { packageCalls.push("setup:" + gistId + ":" + profile); },
    });

    expect(packageCalls).toEqual(["profile", "setup:gist-1:test"]);
  });

  it("includes Pi MCP and personal component directories in the default scope", () => {
    expect(DEFAULT_INCLUDE).toEqual(expect.arrayContaining(["mcp.json", "skills", "prompts", "themes", "agents", "extensions"]));
  });

  it("previews setup, creates a private Gist, persists its identity, and passes doctor", async () => {
    const source = await root();
    await mkdir(join(source, "agents"));
    await writeFile(join(source, "settings.json"), '{\"packages\":[]}');
    await writeFile(join(source, "models.json"), '{\"apiKey\":\"do-not-leak\"}', { mode: 0o600 });
    const client = new MemoryGist();

    const preview = await previewConfig({ agentDir: source, passphrase, client, settings: settings() });
    expect(preview.fileCount).toBe(2);
    expect(preview.paths).toEqual(["models.json", "settings.json"]);
    expect(preview.payloadBytes).toBeGreaterThan(0);

    const setup = await setupSync({ agentDir: source, passphrase, client, settings: settings(), packageConfig: isolatedPackageConfig, packageSetup: async () => {} });
    expect(setup.created).toBe(true);
    expect(setup.settings.gistId).toBe("gist-1");
    expect(await readFile(join(source, "pi-gist-sync.json"), "utf8")).toContain("gist-1");
    const diagnosis = await doctorSync({ agentDir: source, client, passphrase, settings: setup.settings });
    expect(diagnosis.ok).toBe(true);
    expect(diagnosis.checks.every((check) => check.ok)).toBe(true);
    expect(JSON.stringify(client.value)).not.toContain("do-not-leak");
  });

  it("discovers an existing private Gist without writing to it", async () => {
    const source = await root();
    const second = await root();
    await writeFile(join(source, "settings.json"), "source");
    await writeFile(join(second, "settings.json"), "second");
    const client = new MemoryGist();
    await setupSync({ agentDir: source, passphrase, client, settings: settings(), packageConfig: isolatedPackageConfig, packageSetup: async () => {} });
    const before = JSON.stringify(client.value);
    await expect(setupSync({ agentDir: second, passphrase, client, settings: settings(), packageConfig: isolatedPackageConfig })).rejects.toThrow(/existing private Gist/i);
    expect(JSON.stringify(client.value)).toBe(before);
    const matches = await discoverSyncGists({ agentDir: second, client, settings: settings() });
    expect(matches.map((gist) => gist.id)).toEqual(["gist-1"]);
    const restored = await restoreExistingGist({ agentDir: second, passphrase, client, settings: settings(), gistId: "gist-1" });
    expect(restored.gistId).toBe("gist-1");
    expect(await readFile(join(second, "settings.json"), "utf8")).toBe("source");
    expect(JSON.stringify(client.value)).toBe(before);
  });

  it("creates a new Gist only when explicitly requested", async () => {
    const first = await mkdtemp(join(tmpdir(), "pi-gist-create-first-"));
    const second = await mkdtemp(join(tmpdir(), "pi-gist-create-second-"));
    roots.push(first, second);
    await writeFile(join(first, "settings.json"), JSON.stringify({ source: "first" }));
    await writeFile(join(second, "settings.json"), JSON.stringify({ source: "second" }));
    const client = new MultiMemoryGist();
    await setupSync({ agentDir: first, passphrase, client, settings: settings(), packageConfig: isolatedPackageConfig });
    const result = await setupSync({ agentDir: second, passphrase, client, settings: settings(), createNew: true, packageConfig: isolatedPackageConfig });
    expect(result.created).toBe(true);
    expect(result.gistId).not.toBe("gist-1");
    expect(client.value).toHaveLength(2);
  });

  it("reports a failed package status command in doctor", async () => {
    const source = await root();
    await writeFile(join(source, "settings.json"), "source");
    const client = new MemoryGist();
    await pushConfig({ agentDir: source, passphrase, client, settings: settings() });
    const fakeCli = join(source, "failed-status.mjs");
    await writeFile(fakeCli, "process.exit(1)");
    process.env.PI_DEPO_CLI_PATH = fakeCli;

    const packageSettings = { ...settings("gist-1"), piDepo: { ...settings("gist-1").piDepo, enabled: true } };
    const diagnosis = await doctorSync({ agentDir: source, passphrase, client, settings: packageSettings });
    const packageCheck = diagnosis.checks.find((check) => check.name === "package-cli");
    expect(packageCheck?.ok).toBe(false);
    expect(diagnosis.ok).toBe(false);
  });

  it("pushes an encrypted payload and restores it on another agent directory", async () => {
    const source = await root();
    const target = await root();
    await mkdir(join(source, "agents"));
    await writeFile(join(source, "settings.json"), '{\"packages\":[]}');
    await writeFile(join(source, "models.json"), '{\"apiKey\":\"do-not-leak\"}', { mode: 0o600 });
    await writeFile(join(source, "agents", "verifier.md"), "safe");
    const client = new MemoryGist();
    const pushed = await pushConfig({ agentDir: source, passphrase, client, settings: settings() });
    expect(pushed.gistId).toBe("gist-1");
    expect(JSON.stringify(client.value)).not.toContain("do-not-leak");
    await writeFile(join(target, "settings.json"), "old");
    const pulled = await fetchConfig({ agentDir: target, passphrase, client, settings: settings("gist-1") });
    expect(pulled.backupPath).toBeTruthy();
    expect(await readFile(join(target, "models.json"), "utf8")).toContain("apiKey");
    expect(await readFile(join(target, "agents", "verifier.md"), "utf8")).toBe("safe");
    await writeFile(join(target, "settings.json"), "changed-after-pull");
    await restoreBackup({ agentDir: target, backupPath: pulled.backupPath!, passphrase });
    expect(await readFile(join(target, "settings.json"), "utf8")).toBe("old");
  });

  it("rolls back configuration when explicit package sync fails", async () => {
    const source = await root();
    const target = await root();
    await writeFile(join(source, "settings.json"), "source");
    const client = new MemoryGist();
    await pushConfig({ agentDir: source, passphrase, client, settings: settings() });
    await writeFile(join(target, "settings.json"), "old");
    const fakeCli = join(target, "failed-pd.mjs");
    await writeFile(fakeCli, "process.exit(1)");
    process.env.PI_DEPO_CLI_PATH = fakeCli;
    const packageSettings = { ...settings("gist-1"), piDepo: { ...settings("gist-1").piDepo, enabled: true } };
    await expect(fetchConfig({ agentDir: target, passphrase, client, settings: packageSettings, syncPackages: true })).rejects.toThrow(/package sync/i);
    expect(await readFile(join(target, "settings.json"), "utf8")).toBe("old");
  });

  it("does not modify the target when the passphrase is wrong", async () => {
    const source = await root();
    const target = await root();
    await writeFile(join(source, "settings.json"), "source");
    const client = new MemoryGist();
    await pushConfig({ agentDir: source, passphrase, client, settings: settings() });
    await writeFile(join(target, "settings.json"), "unchanged");
    await expect(fetchConfig({ agentDir: target, passphrase: "wrong passphrase", client, settings: settings("gist-1") })).rejects.toThrow();
    expect(await readFile(join(target, "settings.json"), "utf8")).toBe("unchanged");
  });

  it("refuses to update a public Gist", async () => {
    const source = await root();
    await writeFile(join(source, "settings.json"), "source");
    const client = new MemoryGist();
    await pushConfig({ agentDir: source, passphrase, client, settings: settings() });
    if (!client.value) throw new Error("missing test gist");
    client.value.public = true;
    await expect(pushConfig({ agentDir: source, passphrase, client, settings: settings("gist-1") })).rejects.toThrow(/public/i);
  });
});
