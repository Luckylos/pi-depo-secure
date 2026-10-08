import { defineCommand, runMain, type ArgsDef } from "citty";
import pc from "picocolors";
import { sync, status, init, disablePackage, enablePackage, loadManifest, saveManifestFile, addPackage, removePackage } from "./sync.js";
import { login, pushManifest, pullManifest, listProfiles, switchProfile } from "./remote.js";
import { readFile } from "node:fs/promises";
import { kitYmlPath } from "./config.js";
import { VERSION } from "./version.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { diffConfig, doctorSync, fetchConfig, initSync, packagePull, packagePush, packageStatus, previewConfig, pushConfig, restoreBackup, setupSync, syncStatus } from "./config-sync.js";

const main = defineCommand({
  meta: {
    name: "pd",
    version: VERSION,
    description: "Declarative package manager for Pi Coding Agent",
  },
  subCommands: {
    // ─── Core ───────────────────────────────────────────────
    init: defineCommand({
      meta: { name: "init", description: "Bootstrap kit.yml from current Pi installation" },
      async run() {
        await init();
      },
    }),

    sync: defineCommand({
      meta: { name: "sync", description: "Sync desired state (kit.yml) → real state" },
      args: {
        dry: {
          type: "boolean",
          alias: "d",
          description: "Dry run - show actions without executing",
          default: false,
        },
      },
      async run({ args }) {
        await sync(args.dry as boolean);
      },
    }),

    status: defineCommand({
      meta: { name: "status", description: "Show package status" },
      async run() {
        await status();
      },
    }),

    diff: defineCommand({
      meta: { name: "diff", description: "Show diff between kit.yml and real state (dry-run sync)" },
      async run() {
        await sync(true);
      },
    }),

    verify: defineCommand({
      meta: { name: "verify", description: "Run verify checks for all packages" },
      async run() {
        const manifest = await loadManifest();
        const { getProvider } = await import("./providers.js");
        const { inferInstallType } = await import("./manifest.js");

        console.log(pc.bold("\n  Verifying packages...\n"));

        for (const [name, pkg] of Object.entries(manifest.packages)) {
          const type = inferInstallType(pkg);
          const provider = getProvider(type);
          const ok = await provider.verify(name, pkg);
          console.log(`  ${ok ? pc.green("✅") : pc.red("❌")} ${name} (${type})`);
        }

        for (const [name, mcp] of Object.entries(manifest.mcp_servers)) {
          const provider = getProvider("mcp-server");
          const ok = await provider.verify(name, mcp);
          console.log(`  ${ok ? pc.green("✅") : pc.red("❌")} ${name} (mcp-server)`);
        }
        console.log();
      },
    }),

    toggle: defineCommand({
      meta: { name: "toggle", description: "Interactively enable/disable packages" },
      async run() {
        const prompts = (await import("prompts")).default;
        const { inferInstallType } = await import("./manifest.js");

        const manifest = await loadManifest();
        const all = [
          ...Object.entries(manifest.packages),
          ...Object.entries(manifest.mcp_servers),
        ];

        if (all.length === 0) {
          console.log(pc.yellow("  No packages in kit.yml."));
          return;
        }

        const { selected } = await prompts({
          type: "multiselect",
          name: "selected",
          message: "Toggle packages  (space = toggle, enter = apply, ctrl+c = cancel)",
          choices: all.map(([name, pkg]) => ({
            title: `${name}  ${pc.dim(`(${inferInstallType(pkg)})`)}`,
            value: name,
            selected: pkg.rating !== "disabled",
          })),
          hint: " ",
          instructions: false,
        }, { onCancel: () => process.exit(0) });

        const selectedSet = new Set(selected as string[]);
        let changed = false;

        for (const [name, pkg] of all) {
          const shouldBeEnabled = selectedSet.has(name);
          const isEnabled = pkg.rating !== "disabled";
          if (shouldBeEnabled && !isEnabled) {
            pkg.rating = "useful";
            delete pkg.reason;
            changed = true;
          } else if (!shouldBeEnabled && isEnabled) {
            pkg.rating = "disabled";
            changed = true;
          }
        }

        if (!changed) {
          console.log(pc.dim("  No changes."));
          return;
        }

        await saveManifestFile(manifest);
        console.log();
        await sync();
      },
    }),

    upgrade: defineCommand({
      meta: { name: "upgrade", description: "Update non-pinned packages to latest" },
      async run() {
        console.log(pc.yellow("  Not yet implemented. Use 'pi update' for pi-native packages."));
      },
    }),

    add: defineCommand({
      meta: { name: "add", description: "Install a package, add to kit.yml and push to gist" },
      args: {
        source: { type: "positional", description: "Package source (npm:foo, git:github.com/user/repo, or just foo)", required: true },
        rating: { type: "string", alias: "r", description: "Rating: core, useful (default), debatable", default: "useful" },
        subpath: { type: "string", alias: "s", description: "Skill subpath in repo (e.g. skills/diagram-design) - marks as skill type" },
      },
      async run({ args }) {
        await addPackage(args.source as string, (args.rating as "core" | "useful" | "debatable") ?? "useful", args.subpath as string | undefined);
      },
    }),

    a: defineCommand({
      meta: { name: "a", description: "Alias for add" },
      args: {
        source: { type: "positional", description: "Package source", required: true },
        rating: { type: "string", alias: "r", description: "Rating: core, useful (default), debatable", default: "useful" },
        subpath: { type: "string", alias: "s", description: "Skill subpath in repo" },
      },
      async run({ args }) {
        await addPackage(args.source as string, (args.rating as "core" | "useful" | "debatable") ?? "useful", args.subpath as string | undefined);
      },
    }),

    remove: defineCommand({
      meta: { name: "remove", description: "Uninstall a package, remove from kit.yml and push to gist" },
      args: {
        name: { type: "positional", description: "Package name", required: true },
      },
      async run({ args }) {
        await removePackage(args.name as string);
      },
    }),

    rm: defineCommand({
      meta: { name: "rm", description: "Alias for remove" },
      args: {
        name: { type: "positional", description: "Package name", required: true },
      },
      async run({ args }) {
        await removePackage(args.name as string);
      },
    }),

    disable: defineCommand({
      meta: { name: "disable", description: "Disable a package (sets rating=disabled in kit.yml and syncs)" },
      args: {
        name: { type: "positional", description: "Package name", required: true },
        reason: { type: "string", alias: "r", description: "Reason for disabling" },
      },
      async run({ args }) {
        await disablePackage(args.name as string, args.reason as string | undefined);
      },
    }),

    enable: defineCommand({
      meta: { name: "enable", description: "Enable a previously disabled package and sync" },
      args: {
        name: { type: "positional", description: "Package name", required: true },
      },
      async run({ args }) {
        await enablePackage(args.name as string);
      },
    }),

    prune: defineCommand({
      meta: { name: "prune", description: "Remove packages not in kit.yml" },
      async run() {
        console.log(pc.yellow("  Not yet implemented."));
      },
    }),

    // ─── Remote (gist-first) ────────────────────────────────
    login: defineCommand({
      meta: { name: "login", description: "Authenticate with GitHub or Codeberg" },
      args: {
        provider: {
          type: "string",
          alias: "p",
          description: "Remote provider (github or codeberg)",
          default: "github",
        },
      },
      async run({ args }) {
        await login(args.provider as "github" | "codeberg");
      },
    }),

    push: defineCommand({
      meta: { name: "push", description: "Upload kit.yml + lock to remote gist repo" },
      async run() {
        const content = await readFile(kitYmlPath(), "utf-8");
        await pushManifest(content);
      },
    }),

    pull: defineCommand({
      meta: { name: "pull", description: "Download kit.yml from remote gist repo" },
      async run() {
        const content = await pullManifest();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(kitYmlPath(), content, "utf-8");
        console.log(pc.green("  ✅ Pulled kit.yml from remote.\n"));
      },
    }),

    profiles: defineCommand({
      meta: { name: "profiles", description: "List configured profiles" },
      async run() {
        await listProfiles();
      },
    }),

    profile: defineCommand({
      meta: { name: "profile", description: "Switch active profile" },
      args: {
        name: {
          type: "positional",
          description: "Profile name to switch to",
          required: true,
        },
      },
      async run({ args }) {
        await switchProfile(args.name as string);
      },
    }),

    "gist-sync": defineCommand({
      meta: { name: "gist-sync", description: "Sync encrypted Pi configuration through a private GitHub Gist" },
      subCommands: {
        setup: defineCommand({
          meta: { name: "setup", description: "Create or reuse a private Gist and upload an encrypted Pi snapshot" },
          args: syncArgs({ gistId: { type: "string", description: "Existing private Gist ID" }, profile: { type: "string", description: "Profile name", default: "default" } }),
          async run({ args }) {
            rejectCombinedPackageFlag();
            const root = piAgentDir(args.agentDir as string | undefined);
            const phrase = await readPassphrase(args.passphraseStdin === true);
            const preview = await previewConfig({ agentDir: root, passphrase: phrase });
            if (args.json) console.log(JSON.stringify(preview, null, 2)); else printConfigPreview(preview);
            requireYes(args.yes === true, "setup");
            const result = await setupSync({ agentDir: root, passphrase: phrase, gistId: args.gistId as string | undefined, profile: args.profile as string | undefined });
            if (args.json) console.log(JSON.stringify(result, null, 2)); else console.log(pc.green("  " + (result.created ? "Created" : "Updated") + " private Gist " + result.gistId + "."));
          },
        }),
        init: defineCommand({
          meta: { name: "init", description: "Initialize local Gist Sync settings without uploading" },
          args: { agentDir: { type: "string", description: "Pi agent directory" }, gistId: { type: "string", description: "Existing private Gist ID" }, profile: { type: "string", description: "Profile name", default: "default" } },
          async run({ args }) {
            const settings = await initSync({ agentDir: piAgentDir(args.agentDir as string | undefined), gistId: args.gistId as string | undefined, profile: args.profile as string | undefined });
            console.log(pc.green("  Initialized local profile " + settings.profile + "."));
          },
        }),
        status: defineCommand({
          meta: { name: "status", description: "Show encrypted configuration sync status" },
          args: syncArgs(),
          async run({ args }) {
            const result = await syncStatus({ agentDir: piAgentDir(args.agentDir as string | undefined) });
            if (args.json) { console.log(JSON.stringify(result, null, 2)); return; }
            if (!result.configured) { console.log(pc.yellow("  Gist Sync is not configured.")); return; }
            console.log("  Gist: " + result.gistId);
            console.log("  Files: " + result.manifest?.fileCount);
            console.log("  Generated: " + result.manifest?.generatedAt);
            console.log("  Backups: " + result.backupCount);
            if (result.packageStatus) console.log("  pi-depo: " + (result.packageStatus.available ? "available" : "not found"));
          },
        }),
        doctor: defineCommand({
          meta: { name: "doctor", description: "Check authentication, Gist integrity, backups, and package availability" },
          args: syncArgs(),
          async run({ args }) {
            const root = piAgentDir(args.agentDir as string | undefined);
            const phrase = process.env.PI_GIST_SYNC_PASSPHRASE ?? (args.passphraseStdin ? await readPassphrase(true) : undefined);
            const result = await doctorSync({ agentDir: root, passphrase: phrase });
            if (args.json) console.log(JSON.stringify(result, null, 2));
            else for (const check of result.checks) console.log((check.ok ? pc.green("OK  ") : pc.red("FAIL")) + " " + check.name + ": " + check.detail);
            if (!result.ok) process.exitCode = 1;
          },
        }),
        diff: defineCommand({
          meta: { name: "diff", description: "Compare local configuration with the encrypted Gist" },
          args: syncArgs(),
          async run({ args }) {
            const result = await diffConfig({ agentDir: piAgentDir(args.agentDir as string | undefined), passphrase: await readPassphrase(args.passphraseStdin === true) });
            if (args.json) console.log(JSON.stringify(result, null, 2)); else printConfigDiff(result.diff);
          },
        }),
        push: defineCommand({
          meta: { name: "push", description: "Preview, confirm, encrypt, and push Pi configuration" },
          args: syncArgs(),
          async run({ args }) {
            rejectCombinedPackageFlag();
            const root = piAgentDir(args.agentDir as string | undefined);
            const phrase = await readPassphrase(args.passphraseStdin === true);
            const preview = await previewConfig({ agentDir: root, passphrase: phrase });
            if (args.json) console.log(JSON.stringify(preview, null, 2)); else printConfigPreview(preview);
            requireYes(args.yes === true, "push");
            const result = await pushConfig({ agentDir: root, passphrase: phrase });
            if (args.json) console.log(JSON.stringify(result, null, 2)); else console.log(pc.green("  Configuration pushed to Gist " + result.gistId + "."));
          },
        }),
        pull: defineCommand({
          meta: { name: "pull", description: "Preview, confirm, and restore Pi configuration from the encrypted Gist" },
          args: syncArgs({ prune: { type: "boolean", description: "Delete managed files absent from the Gist", default: false } }),
          async run({ args }) {
            rejectCombinedPackageFlag();
            const root = piAgentDir(args.agentDir as string | undefined);
            const phrase = await readPassphrase(args.passphraseStdin === true);
            const preview = await diffConfig({ agentDir: root, passphrase: phrase });
            if (args.json) console.log(JSON.stringify(preview, null, 2)); else printConfigDiff(preview.diff);
            requireYes(args.yes === true, "pull");
            const result = await fetchConfig({ agentDir: root, passphrase: phrase, prune: args.prune === true });
            if (args.json) console.log(JSON.stringify(result, null, 2)); else { console.log(pc.green("  Configuration restored. Backup: " + result.backupPath)); printConfigDiff(result.diff!); }
          },
        }),
        restore: defineCommand({
          meta: { name: "restore", description: "Restore a local encrypted backup" },
          args: syncArgs({ backup: { type: "positional", description: "Backup directory", required: true }, prune: { type: "boolean", description: "Delete managed files absent from the backup", default: false } }),
          async run({ args }) {
            requireYes(args.yes === true, "restore");
            const result = await restoreBackup({ agentDir: piAgentDir(args.agentDir as string | undefined), backupPath: String(args.backup ?? ""), passphrase: await readPassphrase(args.passphraseStdin === true), prune: args.prune === true });
            if (args.json) console.log(JSON.stringify(result, null, 2)); else console.log(pc.green("  Backup restored."));
          },
        }),
        packages: defineCommand({
          meta: { name: "packages", description: "Run a controlled pi-depo package operation" },
          args: syncArgs({ action: { type: "positional", description: "status, push, pull, or sync", required: true } }),
          async run({ args }) {
            const root = piAgentDir(args.agentDir as string | undefined);
            const action = String(args.action ?? "");
            if (action === "status") { console.log((await packageStatus(root)).output); return; }
            requireYes(args.yes === true, "packages " + action);
            if (action === "push") { console.log((await packagePush(root)).output); return; }
            if (action === "pull" || action === "sync") { console.log((await packagePull(action === "sync", root)).output); return; }
            throw new Error("Action must be status, push, pull, or sync");
          },
        }),
      },
    }),
  },
});

function syncArgs(extra: ArgsDef = {}): ArgsDef {
  return { agentDir: { type: "string", description: "Pi agent directory" }, json: { type: "boolean", description: "Print JSON", default: false }, passphraseStdin: { type: "boolean", description: "Read passphrase from stdin", default: false }, yes: { type: "boolean", description: "Confirm a write operation", default: false }, ...extra };
}

function rejectCombinedPackageFlag(): void {
  if (process.argv.includes("--packages")) throw new Error("Configuration commands do not run package operations. Use 'pd gist-sync packages push|pull|sync' instead.");
}

function requireYes(value: boolean, action: string): void {
  if (!value) throw new Error("Refusing " + action + " without --yes; review the preview first");
}

function piAgentDir(override?: string): string { return override ?? process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }

async function readPassphrase(fromStdin: boolean): Promise<string> {
  const fromEnvironment = process.env.PI_GIST_SYNC_PASSPHRASE;
  if (fromEnvironment) return fromEnvironment;
  if (!fromStdin) throw new Error("Set PI_GIST_SYNC_PASSPHRASE or use --passphrase-stdin; passphrases are never accepted as CLI arguments");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const value = input.trimEnd();
  if (!value) throw new Error("Passphrase input was empty");
  return value;
}

function printConfigPreview(preview: { profile: string; fileCount: number; payloadBytes: number; paths: string[]; gistId?: string }): void {
  console.log("  Profile: " + preview.profile);
  console.log("  Target: " + (preview.gistId ?? "new private Gist"));
  console.log("  Files: " + preview.fileCount);
  console.log("  Encrypted payload: " + preview.payloadBytes + " bytes");
  for (const path of preview.paths) console.log("    - " + path);
}

function printConfigDiff(diff: { added: { path: string }[]; modified: { path: string }[]; deleted: string[] }): void {
  console.log("  Added: " + diff.added.length);
  for (const entry of diff.added) console.log("    + " + entry.path);
  console.log("  Modified: " + diff.modified.length);
  for (const entry of diff.modified) console.log("    ~ " + entry.path);
  console.log("  Deleted: " + diff.deleted.length);
  for (const path of diff.deleted) console.log("    - " + path);
}

// pd with no args = pd sync, anything else goes to citty
if (!process.argv[2]) {
  sync().catch(e => { console.error(e); process.exit(1); });
} else {
  runMain(main);
}
