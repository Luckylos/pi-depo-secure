interface ExtensionCommandContext {
  hasUI: boolean;
  ui: SecretPromptUI & {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}
interface ExtensionAPI {
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }): void;
}

import { homedir } from "node:os";
import { join } from "node:path";
import { diffConfig, discoverSyncGists, doctorSync, fetchConfig, initSync, loadSyncSettings, packagePull, packagePush, packageStatus, previewConfig, pushConfig, restoreBackup, restoreExistingGist, setupSync, syncStatus } from "../src/config-sync.js";
import { promptConfirmedSecret, promptSecret, type SecretPromptUI } from "../src/secret-input.js";
import { authenticateGithub, githubAuthStatus } from "../src/github-auth.js";

function agentDir(): string { return process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }

function passphraseFromEnvironment(): string | undefined {
  const value = process.env.PI_GIST_SYNC_PASSPHRASE;
  return value?.length ? value : undefined;
}

async function passphrase(ctx: { hasUI: boolean; ui: SecretPromptUI }): Promise<string> {
  const fromEnvironment = passphraseFromEnvironment();
  if (fromEnvironment) return fromEnvironment;
  if (!ctx.hasUI) throw new Error("Set PI_GIST_SYNC_PASSPHRASE for non-interactive use");
  const value = await promptSecret(ctx.ui, "Pi Gist Sync passphrase");
  if (!value) throw new Error("Passphrase input was cancelled");
  return value;
}

async function confirmedPassphrase(ctx: { hasUI: boolean; ui: SecretPromptUI }): Promise<string> {
  const fromEnvironment = passphraseFromEnvironment();
  if (fromEnvironment) return fromEnvironment;
  if (!ctx.hasUI) throw new Error("Set PI_GIST_SYNC_PASSPHRASE for non-interactive use");
  return promptConfirmedSecret(ctx.ui, "Pi Gist Sync passphrase");
}

function optionValue(parts: string[], name: string): string | undefined {
  const prefix = name + "=";
  const inline = parts.find((part) => part.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = parts.indexOf(name);
  return index >= 0 ? parts[index + 1] : undefined;
}

function hasFlag(parts: string[], name: string): boolean { return parts.includes(name) || parts.some((part) => part.startsWith(name + "=")); }

function diffText(diff: { added: { path: string }[]; modified: { path: string }[]; deleted: string[] }): string {
  const lines = ["Added: " + diff.added.length, "Modified: " + diff.modified.length, "Deleted: " + diff.deleted.length];
  for (const entry of diff.added) lines.push("  + " + entry.path);
  for (const entry of diff.modified) lines.push("  ~ " + entry.path);
  for (const path of diff.deleted) lines.push("  - " + path);
  return lines.join("\n");
}

function previewText(preview: { profile: string; fileCount: number; payloadBytes: number; paths: string[]; gistId?: string }): string {
  const lines = ["Profile: " + preview.profile, "Target: " + (preview.gistId ?? "new private Gist"), "Files: " + preview.fileCount, "Encrypted payload: " + preview.payloadBytes + " bytes", "Managed paths:"];
  for (const path of preview.paths) lines.push("  - " + path);
  return lines.join("\n");
}

async function confirmWrite(ctx: { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } }, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI) throw new Error("Interactive confirmation is required for this operation");
  return ctx.ui.confirm(title, message);
}

async function ensureGithubAuthForExtension(ctx: ExtensionCommandContext): Promise<void> {
  const status = await githubAuthStatus();
  if (status.authenticated) return;
  if (!ctx.hasUI) throw new Error(status.detail + " Run 'pd gist-sync auth' in a terminal.");
  if (!(await confirmWrite(ctx, "Authenticate GitHub", "A browser/device login will be started. Complete it on any device, then return to Pi."))) throw new Error("GitHub authentication cancelled");
  await authenticateGithub({ onOutput: (chunk) => { const message = chunk.trim(); if (message) ctx.ui.notify(message, "info"); } });
}

export default function register(pi: ExtensionAPI): void {
  pi.registerCommand("gist-sync", {
    description: "Synchronize encrypted Pi configuration through a private GitHub Gist",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const combinedPackageFlag = hasFlag(parts, "--packages");
      const prune = hasFlag(parts, "--prune");
      const root = optionValue(parts, "--agent-dir") ?? agentDir();
      try {
        if (combinedPackageFlag && (action === "setup" || action === "push" || action === "pull")) {
          throw new Error("Configuration commands do not run package operations. Use /gist-sync packages push|pull|sync instead.");
        }
        if (action === "init") {
          const settings = await initSync({ agentDir: root, gistId: optionValue(parts, "--gist-id") ?? parts[1], profile: optionValue(parts, "--profile") });
          ctx.ui.notify("Pi Gist Sync local settings initialized for profile " + settings.profile, "info");
          return;
        }
        if (action === "auth") {
          if (!ctx.hasUI) throw new Error("Interactive confirmation is required for GitHub auth. Run 'pd gist-sync auth' in a terminal.");
          await ensureGithubAuthForExtension(ctx);
          ctx.ui.notify("GitHub authentication is ready.", "info");
          return;
        }
        if (action === "setup") {
          if (!ctx.hasUI) throw new Error("Interactive confirmation is required for setup");
          await ensureGithubAuthForExtension(ctx);
          const current = await loadSyncSettings(root);
          const requestedGist = optionValue(parts, "--gist-id");
          const createNew = hasFlag(parts, "--create");
          if (current.gistId && !requestedGist) throw new Error("Pi Gist Sync is already configured. Use /gist-sync push or /gist-sync pull.");
          const phrase = await confirmedPassphrase(ctx);
          const restoreGistId = requestedGist;
          if (restoreGistId) {
            const restoreSettings = { ...current, gistId: restoreGistId };
            const preview = await diffConfig({ agentDir: root, passphrase: phrase, settings: restoreSettings });
            ctx.ui.notify("Existing private Gist found. Restore preview:\n" + diffText(preview.diff), "info");
            if (!(await confirmWrite(ctx, "Restore existing Pi Gist Sync?", "A local encrypted backup will be created before writing."))) return;
            const result = await restoreExistingGist({ agentDir: root, passphrase: phrase, gistId: restoreGistId, settings: current });
            ctx.ui.notify("Configuration restored from Gist " + result.gistId + ". Backup: " + result.backupPath, "info");
            return;
          }
          const matches = createNew ? [] : await discoverSyncGists({ agentDir: root, settings: current });
          if (matches.length > 1) throw new Error("Multiple matching private Gists found. Use /gist-sync setup --gist-id=<id> or --create.");
          if (matches.length === 1) {
            const existing = matches[0];
            ctx.ui.notify("Existing private Gist found: " + existing.id + "\n" + (existing.description ?? ""), "info");
            if (await confirmWrite(ctx, "Restore existing Pi Gist Sync?", "This restores the cloud configuration and does not upload this machine first.")) {
              const restoreSettings = { ...current, gistId: existing.id };
              const preview = await diffConfig({ agentDir: root, passphrase: phrase, settings: restoreSettings });
              ctx.ui.notify(diffText(preview.diff), "info");
              if (!(await confirmWrite(ctx, "Apply cloud configuration?", "A local encrypted backup will be created before writing."))) return;
              const result = await restoreExistingGist({ agentDir: root, passphrase: phrase, gistId: existing.id, settings: current });
              ctx.ui.notify("Configuration restored from Gist " + result.gistId + ". Backup: " + result.backupPath, "info");
              return;
            }
            if (!(await confirmWrite(ctx, "Create a new private Gist instead?", "Only this machine's encrypted configuration will be uploaded."))) return;
          }
          const preview = await previewConfig({ agentDir: root, passphrase: phrase, settings: current, createNew: true });
          ctx.ui.notify(previewText(preview), "info");
          if (!(await confirmWrite(ctx, "Create a new Pi Gist Sync?", "A new private Gist will receive an encrypted snapshot. Package operations will not run."))) return;
          const result = await setupSync({ agentDir: root, passphrase: phrase, profile: optionValue(parts, "--profile"), settings: current, createNew: true });
          ctx.ui.notify("Created private Gist " + result.gistId + " (" + result.manifest.fileCount + " files)", "info");
          return;
        }
        if (action === "status") {
          const result = await syncStatus({ agentDir: root });
          if (!result.configured) { ctx.ui.notify("Pi Gist Sync is not configured. Use /gist-sync setup", "warning"); return; }
          const packageLine = result.packageStatus ? "\npi-depo: " + (result.packageStatus.available ? "available" : "not found") : "";
          ctx.ui.notify("Gist: " + result.gistId + "\nFiles: " + result.manifest?.fileCount + "\nGenerated: " + result.manifest?.generatedAt + "\nBackups: " + result.backupCount + packageLine, "info");
          return;
        }
        if (action === "doctor") {
          const localSettings = await loadSyncSettings(root);
          let phrase = passphraseFromEnvironment();
          if (!phrase && ctx.hasUI && localSettings.gistId) phrase = await passphrase(ctx);
          const diagnosis = await doctorSync({ agentDir: root, passphrase: phrase });
          const lines = diagnosis.checks.map((check) => (check.ok ? "OK  " : "FAIL") + " " + check.name + ": " + check.detail);
          ctx.ui.notify(lines.join("\n"), diagnosis.ok ? "info" : "warning");
          return;
        }
        if (action === "packages") {
          const subcommand = parts[1] ?? "status";
          if (subcommand === "status") {
            const result = await packageStatus(root);
            ctx.ui.notify(result.available ? result.output || "pi-depo status completed" : "pi-depo is not installed", result.available ? "info" : "warning");
            return;
          }
          if (subcommand === "push") {
            if (!(await confirmWrite(ctx, "Push pi-depo package state?", "This updates the package Gist."))) return;
            const result = await packagePush(root);
            if (!result.available || result.exitCode !== 0) throw new Error(result.output || "pi-depo package push failed");
            ctx.ui.notify(result.output || "pi-depo package push completed", "info");
            return;
          }
          if (subcommand === "pull" || subcommand === "sync") {
            if (!(await confirmWrite(ctx, "Run pi-depo " + subcommand + "?", "This may install, remove, or update packages."))) return;
            const result = await packagePull(subcommand === "sync", root);
            if (!result.available || result.exitCode !== 0) throw new Error(result.output || "pi-depo package operation failed");
            ctx.ui.notify(result.output || "pi-depo package operation completed", "info");
            return;
          }
          throw new Error("Usage: /gist-sync packages status|push|pull|sync");
        }
        if (action === "diff") {
          const result = await diffConfig({ agentDir: root, passphrase: await passphrase(ctx) });
          ctx.ui.notify(diffText(result.diff), "info");
          return;
        }
        if (action === "push") {
          if (!ctx.hasUI) throw new Error("Interactive confirmation is required for push");
          const phrase = await passphrase(ctx);
          const preview = await previewConfig({ agentDir: root, passphrase: phrase });
          ctx.ui.notify(previewText(preview), "info");
          if (!(await confirmWrite(ctx, "Push Pi configuration?", "The encrypted snapshot will update the private Gist."))) return;
          const result = await pushConfig({ agentDir: root, passphrase: phrase });
          ctx.ui.notify("Configuration pushed to Gist " + result.gistId + " (" + result.manifest.fileCount + " files)", "info");
          return;
        }
        if (action === "pull") {
          if (!ctx.hasUI) throw new Error("Interactive confirmation is required for pull");
          const phrase = await passphrase(ctx);
          const preview = await diffConfig({ agentDir: root, passphrase: phrase });
          ctx.ui.notify(diffText(preview.diff), "info");
          if (!(await confirmWrite(ctx, "Restore Pi configuration?", "A local encrypted backup will be created first."))) return;
          const result = await fetchConfig({ agentDir: root, passphrase: phrase, prune });
          ctx.ui.notify("Configuration restored. Backup: " + result.backupPath + "\n" + diffText(result.diff ?? { added: [], modified: [], deleted: [] }), "info");
          return;
        }
        if (action === "restore") {
          const backup = parts[1];
          if (!backup || backup.startsWith("-")) throw new Error("Usage: /gist-sync restore <backup-directory>");
          if (!(await confirmWrite(ctx, "Restore this Pi backup?", backup))) return;
          await restoreBackup({ agentDir: root, backupPath: backup, passphrase: await passphrase(ctx), prune });
          ctx.ui.notify("Backup restored", "info");
          return;
        }
        throw new Error("Usage: /gist-sync auth|setup|init|status|diff|push|pull|doctor|restore|packages");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Pi Gist Sync failed", "error");
      }
    },
  });
}
