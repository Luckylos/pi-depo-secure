import { VERSION } from "./version.js"
import { commandExists, runCommand } from "./process.js"
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import pc from "picocolors";
import type { KitManifest, PackageManifest, McpServerManifest, SyncAction, InstallType, KitLock, LockEntry } from "./types.js";
import { parseManifest, validateManifest, inferInstallType, parseSource, expandTemplate, serializeManifest } from "./manifest.js";
import { saveLock, kitYmlPath, loadConfig, templateVars } from "./config.js";
import { getProvider } from "./providers.js";
import { pullManifest } from "./remote.js";

// ─── Self-update check ─────────────────────────────────────────
// ─── Self-update pd ───────────────────────────────────────────
const MAX_UPDATE_ATTEMPTS = 3;
const PD_PACKAGE = "pi-depo-secure";

const OLD_PI_PACKAGE = "@mariozechner/pi-coding-agent";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Returns true iff semver a > b (simple x.y.z, no pre-release). */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

// ─── Update pi agent itself ─────────────────────────────
async function updatePiAgent(): Promise<string | null> {
  try {
    const viewResult = await runCommand("npm", ["view", PI_PACKAGE, "version"]);
    if (viewResult.exitCode !== 0) return null;
    const latest = viewResult.stdout.toString().trim();
    if (!latest) return null;

    // Use pi --version to get installed version (works with vp-managed installs)
    const versionResult = await runCommand("pi", ["--version"]);
    const installed = versionResult.exitCode === 0 ? versionResult.stdout.toString().trim() : null;

    // Detect legacy @mariozechner install and migrate transparently
    let needsMigration = false;
    try {
      const listResult = await runCommand("npm", ["list", "-g", OLD_PI_PACKAGE, "--json", "--depth=0"]);
      if (listResult.exitCode === 0) {
        const data = JSON.parse(listResult.stdout.toString()) as { dependencies?: Record<string, unknown> };
        needsMigration = !!(data.dependencies?.[OLD_PI_PACKAGE]);
      }
    } catch { /* ignore */ }

    if (needsMigration) {
      // During migration, install the new package regardless of version
      // (old and new namespaces may lag each other briefly)
      const target = installed && semverGt(installed, latest) ? installed : latest;
      console.log(pc.yellow(`  Migrating pi: ${OLD_PI_PACKAGE} → ${PI_PACKAGE}@${target}...`));
      await runCommand("npm", ["uninstall", "-g", OLD_PI_PACKAGE]);
      const result = await runCommand("npm", ["install", "-g", PI_PACKAGE + "@" + target]);
      if (result.exitCode === 0) {
        console.log(pc.green(`  ✅ pi migrated to ${PI_PACKAGE}@${target}`));
        return target;
      }
      console.log(pc.red(`  ❌ pi migration failed`));
      return installed;
    }

    // Never downgrade - only proceed if latest is strictly newer
    if (installed && !semverGt(latest, installed)) return installed;
    console.log(pc.yellow(`  ⬆  pi ${installed ?? "?"} → ${latest}, updating...`));
    const result = await runCommand("npm", ["install", "-g", PI_PACKAGE + "@" + latest]);
    if (result.exitCode === 0) {
      console.log(pc.green(`  ✅ pi updated to ${latest}`));
      return latest;
    } else {
      console.log(pc.red(`  ❌ pi update failed`));
      return installed;
    }
  } catch { return null; }
}

// ─── Run pi update (git packages + anything not in kit.yml) ───
// ─── Reconcile orphans (installed via pi but not in kit.yml) ───
async function reconcileOrphans(manifest: KitManifest): Promise<boolean> {
  const result = await runCommand("pi", ["list"]);
  if (result.exitCode !== 0) return false;

  // Parse pi list: source lines (2 spaces) followed by path lines (4 spaces)
  const lines = result.stdout.toString().split("\n");
  const piPackages: Array<{ source: string; basename: string }> = [];
  let currentSource: string | null = null;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim() || trimmed.trim() === "User packages:") continue;
    if (trimmed.startsWith("    ")) {
      // Path line
      if (currentSource) {
        const parts = trimmed.trim().split("/");
        const basename = parts[parts.length - 1]!;
        if (basename) piPackages.push({ source: currentSource, basename });
        currentSource = null;
      }
    } else if (trimmed.startsWith("  ")) {
      // Source line
      currentSource = trimmed.trim();
    }
  }

  const kitNames = new Set(Object.keys(manifest.packages));
  const orphans = piPackages.filter(p => !kitNames.has(p.basename));
  if (orphans.length === 0) return false;

  console.log(pc.yellow(`\n  Found ${orphans.length} package(s) installed but not in kit.yml:`));

  const prompts = (await import("prompts")).default;
  let changed = false;

  for (const orphan of orphans) {
    const { action } = await prompts({
      type: "select",
      name: "action",
      message: `${pc.bold(orphan.basename)} ${pc.dim(orphan.source)}`,
      choices: [
        { title: `${pc.green("Add")} as core     (essential, always installed)`, value: "core" },
        { title: `${pc.cyan("Add")} as useful    (nice to have)`, value: "useful" },
        { title: `${pc.dim("Add")} as debatable  (optional)`, value: "debatable" },
        { title: `${pc.red("Remove")}            (pi remove + never track)`, value: "remove" },
        { title: `${pc.dim("Skip")}              (ask again next sync)`, value: "skip" },
      ],
    }, { onCancel: () => process.exit(0) });

    if (!action || action === "skip") continue;

    if (action === "remove") {
      console.log(pc.dim(`  Removing ${orphan.basename}...`));
      await runCommand("pi", ["remove", orphan.source]);
      console.log(pc.green(`  ✅ ${orphan.basename} removed`));
    } else {
      manifest.packages[orphan.basename] = { source: orphan.source, rating: action as "core" | "useful" | "debatable" };
      console.log(pc.green(`  ✅ ${orphan.basename} added as ${action}`));
      changed = true;
    }
  }

  if (changed) {
    await saveManifestFile(manifest);
    // Push updated kit.yml to gist
    try {
      const { pushManifest } = await import("./remote.js");
      const { readFile } = await import("node:fs/promises");
      const { kitYmlPath } = await import("./config.js");
      const content = await readFile(kitYmlPath(), "utf-8");
      await pushManifest(content);
      console.log(pc.green("  ✅ kit.yml pushed to gist"));
    } catch (e) {
      console.log(pc.yellow(`  ⚠  Could not push to gist: ${e instanceof Error ? e.message : e}`));
    }
  }

  return changed;
}

async function selfUpdate(currentVersion: string): Promise<boolean> {
  const attempt = parseInt(process.env.PKIT_UPDATE_ATTEMPT ?? "0", 10);
  if (attempt >= MAX_UPDATE_ATTEMPTS) {
    console.log(pc.yellow(`  ⚠  pd: update retry limit reached (${MAX_UPDATE_ATTEMPTS}), skipping auto-update`));
    return false;
  }

  try {
    // npm view returns only versions that are actually downloadable
    const viewResult = await runCommand("npm", ["view", PD_PACKAGE, "version"]);
    if (viewResult.exitCode !== 0) return false;
    const latest = viewResult.stdout.toString().trim();
    if (!latest || latest === currentVersion) return false;

    console.log(pc.yellow(`  ⬆  pd ${currentVersion} → ${latest}, updating...`));
    const result = await runCommand("npm", ["install", "-g", PD_PACKAGE + "@" + latest]);
    if (result.exitCode !== 0) {
      console.log(pc.red(`  ❌ pd update failed\n`));
      return false;
    }

    // Parse installed version from npm output
    const out = result.stdout.toString() + result.stderr.toString();
    const match = out.match(/pi-depo-secure@([\d.]+)/);
    const installedVersion = match?.[1] ?? latest;

    if (installedVersion === currentVersion) {
      return false;
    }

    console.log(pc.green(`  ✅ pd updated to ${installedVersion}, restarting...\n`));
    const pdBin = (await commandExists("pd")) ? "pd" : null;
    if (pdBin) {
      const { spawnSync } = await import("child_process");
      spawnSync(pdBin, process.argv.slice(2), {
        stdio: "inherit",
        env: { ...process.env, PKIT_UPDATE_ATTEMPT: String(attempt + 1) },
      });
    }
    process.exit(0);
  } catch {
    // network unavailable or timeout - skip silently
  }
  return false;
}

// ─── Load manifest (gist-first) ─────────────────────────────────
export async function loadManifest(cwd?: string): Promise<KitManifest> {
  const localPath = kitYmlPath(cwd);
  const config = await loadConfig();
  const activeProfile = config.profiles?.[config.active_profile ?? "default"];
  const isLoggedIn = Boolean(activeProfile?.gist_id);

  if (isLoggedIn) {
    // Always pull from gist when logged in - gist is the source of truth
    try {
      const remoteContent = await pullManifest();
      await writeFile(localPath, remoteContent, "utf-8");
      return parseManifest(remoteContent);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(pc.yellow(`  Could not pull from gist (${msg}), falling back to local file.`));
    }
  }

  // Not logged in (or pull failed) - use local file
  if (existsSync(localPath)) {
    const content = await readFile(localPath, "utf-8");
    return parseManifest(content);
  }

  throw new Error(
    "No kit.yml found. Options:\n" +
    "  1. Run 'pd login' to authenticate and pull your config\n" +
    "  2. Run 'pd init' to bootstrap from your current Pi installation"
  );
}

// ─── Sync command ───────────────────────────────────────────────
export async function sync(dryRun = false, options: { allowUpdates?: boolean } = {}): Promise<SyncAction[]> {
  const allowUpdates = options.allowUpdates ?? process.env.PI_DEPO_ALLOW_UPDATES === "1";
  if (allowUpdates) await selfUpdate(VERSION);
  const [manifest, piVersion] = await Promise.all([
    loadManifest(),
    allowUpdates ? updatePiAgent() : Promise.resolve(null),
  ]);

  // Update pi version in manifest if changed
  if (piVersion && manifest.meta.pi_version !== piVersion) {
    manifest.meta.pi_version = piVersion;
  }
  const errors = validateManifest(manifest);

  if (errors.length > 0) {
    console.log(pc.red("\n  ⚠ Manifest validation issues:"));
    for (const err of errors) {
      console.log(pc.red(`    ${err.path}: ${err.message}`));
    }
    console.log();
  }

  const actions = await computeActions(manifest);

  if (dryRun) {
    printActions(actions);
    return actions;
  }

  // Execute actions
  for (const action of actions) {
    switch (action.action) {
      case "install": {
        const provider = getProvider(action.type);
        console.log(pc.cyan(`  Installing ${action.name} (${action.type})...`));
        try {
          const pkg = manifest.packages[action.name] ?? manifest.mcp_servers[action.name];
          if (pkg) {
            await provider.install(action.name, pkg);
            console.log(pc.green(`  ✅ ${action.name}`));
          }
        } catch (e) {
          console.log(pc.red(`  ❌ ${action.name}: ${e instanceof Error ? e.message : e}`));
          action.status = "error";
          action.detail = e instanceof Error ? e.message : String(e);
        }
        break;
      }
      case "remove": {
        const provider = getProvider(action.type);
        console.log(pc.yellow(`  Removing ${action.name} (disabled)...`));
        try {
          const pkg = manifest.packages[action.name] ?? manifest.mcp_servers[action.name];
          if (pkg) {
            await provider.remove(action.name, pkg);
            console.log(pc.green(`  🗑 ${action.name} removed`));
          }
        } catch (e) {
          console.log(pc.red(`  ❌ Failed to remove ${action.name}: ${e}`));
        }
        break;
      }
      case "skip": {
        const detail = action.detail ? pc.dim(` (${action.detail})`) : "";
        console.log(pc.dim(`  ✓ ${action.name}${detail}`));
        break;
      }
      case "upgrade": {
        const provider = getProvider(action.type);
        console.log(pc.cyan(`  ⬆  ${action.name} ${action.detail ?? ""}...`));
        try {
          const pkg = manifest.packages[action.name] ?? manifest.mcp_servers[action.name];
          if (pkg) {
            await provider.install(action.name, pkg);
            console.log(pc.green(`  ✅ ${action.name} updated`));
          }
        } catch (e) {
          console.log(pc.red(`  ❌ ${action.name}: ${e instanceof Error ? e.message : e}`));
          action.status = "error";
          action.detail = e instanceof Error ? e.message : String(e);
        }
        break;
      }
      case "verify": {
        const provider = getProvider(action.type);
        const pkg = manifest.packages[action.name] ?? manifest.mcp_servers[action.name];
        if (pkg) {
          const ok = await provider.verify(action.name, pkg);
          if (ok) {
            console.log(pc.green(`  ✓ ${action.name} (verified)`));
          } else {
            console.log(pc.yellow(`  ⚠ ${action.name} (verify failed - needs reinstall)`));
          }
        }
        break;
      }
    }
  }

  // Update lock file
  await updateLock(actions);

  // If pi version changed, save updated manifest + push
  if (piVersion && piVersion !== manifest.meta.pi_version) {
    manifest.meta.pi_version = piVersion;
  }
  if (!dryRun) {
    await saveManifestFile(manifest);
  }

  console.log(pc.green("\n  Sync complete.\n"));

  // Run pi update for git-sourced packages (pd can't version-check git commits)
  if (!dryRun && allowUpdates) {
    const hasGitPkgs = Object.values(manifest.packages).some(p =>
      p.rating !== "disabled" && (p.source.startsWith("git:") || p.source.startsWith("http"))
    );
    if (hasGitPkgs) await runCommand("pi", ["update"]);
  }

  if (!dryRun) await reconcileOrphans(manifest);

  return actions;
}

// ─── Status command ─────────────────────────────────────────────
export async function status(): Promise<void> {
  const manifest = await loadManifest();
  const actions = await computeActions(manifest);
  printActions(actions);
}

// Returns Map<basename, installPath>
async function getPiInstalledMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const result = await runCommand("pi", ["list"]);
    if (result.exitCode !== 0) return map;
    for (const line of result.stdout.toString().split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("/")) {
        const parts = trimmed.split("/");
        const basename = parts[parts.length - 1];
        if (basename) map.set(basename, trimmed);
      }
    }
  } catch { /* ignore */ }
  return map;
}

// Read version from package.json at install path
async function readInstalledVersion(installPath: string): Promise<string | null> {
  try {
    const raw = await readFile(`${installPath}/package.json`, "utf-8");
    const { version } = JSON.parse(raw) as { version?: string };
    return version ?? null;
  } catch {
    return null;
  }
}

// Fetch latest version for an npm package spec from registry
async function fetchLatestNpmVersion(spec: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(spec)}/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

// ─── Compute actions (async - checks real state + versions) ───────
async function computeActions(manifest: KitManifest): Promise<SyncAction[]> {
  const vars = templateVars();

  // 1. pi list once → Map<basename, installPath>
  const piInstalledMap = await getPiInstalledMap();

  // 2. For pi-native npm packages: read installed version + fetch latest in parallel
  type NpmCheck = { name: string; pkg: PackageManifest; installPath: string; npmSpec: string; pin?: string };
  const npmChecks: NpmCheck[] = [];

  for (const [name, pkg] of Object.entries(manifest.packages)) {
    const type = inferInstallType(pkg);
    if (type !== "pi-native" || pkg.rating === "disabled") continue;
    const installPath = piInstalledMap.get(name);
    if (!installPath) continue; // not installed, will be handled below
    const parsed = parseSource(expandTemplate(pkg.source, vars));
    if (parsed.type !== "npm") continue;
    npmChecks.push({ name, pkg, installPath, npmSpec: parsed.spec, pin: pkg.pin });
  }

  // Fire all version checks in parallel
  const [installedVersions, latestVersions] = await Promise.all([
    Promise.all(npmChecks.map(c => readInstalledVersion(c.installPath))),
    Promise.all(npmChecks.map(c => c.pin ? Promise.resolve(c.pin) : fetchLatestNpmVersion(c.npmSpec))),
  ]);

  // Build version state map: name → { installed, latest, outdated }
  const versionMap = new Map<string, { installed: string | null; latest: string | null; outdated: boolean }>();
  for (let i = 0; i < npmChecks.length; i++) {
    const installed = installedVersions[i] ?? null;
    const latest = latestVersions[i] ?? null;
    const outdated = !!(installed && latest && installed !== latest);
    versionMap.set(npmChecks[i]!.name, { installed, latest, outdated });
  }

  // 3. Parallel verify for non-pi-native
  type PendingEntry =
    | { kind: "pkg"; name: string; pkg: PackageManifest; type: InstallType }
    | { kind: "mcp"; name: string; mcp: McpServerManifest };

  const pending: PendingEntry[] = [];
  for (const [name, pkg] of Object.entries(manifest.packages)) {
    const type = inferInstallType(pkg);
    if (type !== "pi-native") pending.push({ kind: "pkg", name, pkg, type });
  }
  for (const [name, mcp] of Object.entries(manifest.mcp_servers)) {
    pending.push({ kind: "mcp", name, mcp });
  }

  const verifyResults = await Promise.all(
    pending.map(async entry => {
      if (entry.kind === "pkg") {
        if (entry.pkg.rating === "disabled") return false;
        return getProvider(entry.type).verify(entry.name, entry.pkg);
      } else {
        if (entry.mcp.rating === "disabled") return false;
        return getProvider("mcp-server").verify(entry.name, entry.mcp);
      }
    })
  );

  const verifyMap = new Map<string, boolean>();
  pending.forEach((entry, i) => verifyMap.set(entry.name, verifyResults[i]!));

  // 4. Build actions
  const actions: SyncAction[] = [];

  for (const [name, pkg] of Object.entries(manifest.packages)) {
    const type = inferInstallType(pkg);

    if (pkg.rating === "disabled") {
      const installed = type === "pi-native" ? piInstalledMap.has(name) : verifyMap.get(name);
      actions.push({ name, type, action: installed ? "remove" : "skip", status: "disabled" });
      continue;
    }

    if (type === "pi-native") {
      if (!piInstalledMap.has(name)) {
        actions.push({ name, type, action: "install", status: "missing" });
      } else {
        const v = versionMap.get(name);
        if (v?.outdated) {
          actions.push({ name, type, action: "upgrade", status: "outdated", detail: `${v.installed} → ${v.latest}` });
        } else {
          actions.push({ name, type, action: "skip", status: "synced", detail: v?.installed ?? undefined });
        }
      }
    } else {
      const verified = verifyMap.get(name) ?? false;
      actions.push({ name, type, action: verified ? "skip" : "install", status: verified ? "synced" : "missing" });
    }
  }

  for (const [name, mcp] of Object.entries(manifest.mcp_servers)) {
    if (mcp.rating === "disabled") {
      actions.push({ name, type: "mcp-server", action: verifyMap.get(name) ? "remove" : "skip", status: "disabled" });
    } else {
      const verified = verifyMap.get(name) ?? false;
      actions.push({ name, type: "mcp-server", action: verified ? "skip" : "install", status: verified ? "synced" : "missing" });
    }
  }

  return actions;
}

// ─── Print actions ──────────────────────────────────────────────
const STATUS_ICONS: Record<string, string> = {
  synced: "✅",
  missing: "❌",
  outdated: "⬆️",
  disabled: "🚫",
  orphan: "⚠️",
  drift: "🔧",
  verify_fail: "❓",
  error: "💀",
};

function printActions(actions: SyncAction[]): void {
  console.log(pc.bold("\n  Package Status:\n"));

  // Group by type
  const grouped = new Map<InstallType, SyncAction[]>();
  for (const action of actions) {
    const list = grouped.get(action.type) ?? [];
    list.push(action);
    grouped.set(action.type, list);
  }

  for (const [type, items] of grouped) {
    console.log(pc.dim(`  [${type}]`));
    for (const item of items) {
      const icon = STATUS_ICONS[item.status] ?? "?";
      const rating = item.status === "disabled" ? pc.dim(item.status) : "";
      const detail = item.detail ? pc.dim(` (${item.detail})`) : "";
      console.log(`  ${icon} ${item.name} ${rating}${detail}`);
    }
    console.log();
  }
}

// ─── Update lock ────────────────────────────────────────────────
async function updateLock(actions: SyncAction[]): Promise<void> {
  const lock: KitLock = {
    version: 1,
    synced_at: new Date().toISOString(),
    packages: {},
    mcp_servers: {},
  };

  for (const action of actions) {
    if (action.status === "error") continue;
    const entry: LockEntry = {
      type: action.type,
      installed: action.status === "synced" || action.action === "install",
      verified: action.status === "synced",
      installed_at: new Date().toISOString(),
    };

    if (action.type === "mcp-server") {
      lock.mcp_servers[action.name] = entry;
    } else {
      lock.packages[action.name] = entry;
    }
  }

  await saveLock(lock);
}

// ─── Remove command ───────────────────────────────────────────
export async function removePackage(name: string): Promise<void> {
  const manifest = await loadManifest();
  const pkg = manifest.packages[name] ?? manifest.mcp_servers[name];
  if (!pkg) throw new Error(`Package '${name}' not found in kit.yml`);

  // Uninstall from pi
  console.log(pc.cyan(`  Removing ${name}...`));
  await runCommand("pi", ["remove", pkg.source]);

  // Remove from kit.yml
  delete manifest.packages[name];
  delete manifest.mcp_servers[name];
  await saveManifestFile(manifest);
  console.log(pc.green(`  ✅ ${name} removed.`));

  // Push to gist
  try {
    const { pushManifest } = await import("./remote.js");
    const content = await readFile(kitYmlPath(), "utf-8");
    await pushManifest(content);
  } catch (e) {
    console.log(pc.yellow(`  ⚠  Could not push to gist: ${e instanceof Error ? e.message : e}`));
  }
}

// ─── Disable / Enable commands ─────────────────────────────────
export async function disablePackage(name: string, reason?: string): Promise<void> {
  const manifest = await loadManifest();
  const pkg = manifest.packages[name] ?? manifest.mcp_servers[name];
  if (!pkg) throw new Error(`Package '${name}' not found in kit.yml`);
  if (pkg.rating === "disabled") {
    console.log(pc.yellow(`  ${name} is already disabled.`));
    return;
  }
  pkg.rating = "disabled";
  if (reason) pkg.reason = reason;
  await saveManifestFile(manifest);
  console.log(pc.green(`  ✅ ${name} disabled.`));
  await sync();
}

export async function enablePackage(name: string): Promise<void> {
  const manifest = await loadManifest();
  const pkg = manifest.packages[name] ?? manifest.mcp_servers[name];
  if (!pkg) throw new Error(`Package '${name}' not found in kit.yml`);
  if (pkg.rating !== "disabled") {
    console.log(pc.yellow(`  ${name} is already enabled (rating: ${pkg.rating}).`));
    return;
  }
  pkg.rating = "useful";
  delete pkg.reason;
  await saveManifestFile(manifest);
  console.log(pc.green(`  ✅ ${name} enabled.`));
  await sync();
}

export async function saveManifestFile(manifest: KitManifest): Promise<void> {
  const { serializeManifest } = await import("./manifest.js");
  await writeFile(kitYmlPath(), serializeManifest(manifest), "utf-8");
}

// ─── Add custom package (interactive steps builder) ────────────────
async function addCustomPackage(source: string, rating: "core" | "useful" | "debatable"): Promise<void> {
  const prompts = (await import("prompts")).default;

  const spec = source.replace(/^(npm:|git:|local:)/, "");
  const name = spec.split("/").pop()?.split("@")[0] ?? spec;
  const gitUrl = spec.includes("://") ? spec : `https://${spec}`;
  const defaultCloneDir = `{{home}}/.pi/extensions/${name}`;

  console.log(pc.dim(`\n  Configuring custom install for ${name}...`));
  console.log(pc.dim(`  Use {{home}} for home dir, {{source}} for the git URL.`));
  console.log(pc.dim(`  Suggested clone: git clone ${gitUrl} ${defaultCloneDir}\n`));

  const answers = await prompts([
    {
      type: "text",
      name: "clone",
      message: "Clone step (empty to skip):",
      initial: "",
    },
    {
      type: "text",
      name: "build",
      message: "Build step (empty to skip):",
      initial: "",
    },
    {
      type: "text",
      name: "postinstall",
      message: "Post-install step (empty to skip):",
      initial: "",
    },
    {
      type: "text",
      name: "verify",
      message: "Verify command (shell cmd, exit 0 = ok, empty to skip):",
      initial: "",
    },
  ], { onCancel: () => process.exit(0) });

  const manifest = await loadManifest();
  if (manifest.packages[name]) {
    console.log(pc.yellow(`  ${name} is already in kit.yml.`));
    return;
  }

  const steps: Record<string, string> = {};
  if (answers.clone?.trim()) steps.clone = answers.clone.trim();
  if (answers.build?.trim()) steps.build = answers.build.trim();
  if (answers.postinstall?.trim()) steps.postinstall = answers.postinstall.trim();

  const entry: PackageManifest = { source, rating, type: "custom", steps };
  if (answers.verify?.trim()) {
    entry.verify = { check: answers.verify.trim(), description: `${name} installed` };
  }

  // Run install now
  console.log(pc.cyan(`  Installing ${name}...`));
  const { customProvider } = await import("./providers.js");
  try {
    await customProvider.install(name, entry);
  } catch (e) {
    console.log(pc.red(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`));
    return;
  }

  manifest.packages[name] = entry;
  await saveManifestFile(manifest);
  console.log(pc.green(`  ✅ ${name} added as ${rating} (custom).`));

  try {
    const { pushManifest } = await import("./remote.js");
    const content = await readFile(kitYmlPath(), "utf-8");
    await pushManifest(content);
  } catch (e) {
    console.log(pc.yellow(`  ⚠  Could not push to gist: ${e instanceof Error ? e.message : e}`));
  }
}

// ─── Add command ───────────────────────────────────────────
export async function addPackage(
  source: string,
  rating: "core" | "useful" | "debatable" = "useful",
  skillSubpath?: string,
): Promise<void> {
  const normalizedSource = source.includes(":") ? source : `npm:${source}`;
  const isGit = normalizedSource.startsWith("git:") || normalizedSource.startsWith("http");

  // For git sources without --subpath: ask what type it is
  let resolvedSubpath = skillSubpath;
  let installType: "pi-native" | "skill" | undefined = skillSubpath ? "skill" : undefined;

  if (isGit && !skillSubpath) {
    const prompts = (await import("prompts")).default;
    const { type } = await prompts({
      type: "select",
      name: "type",
      message: `What type is ${normalizedSource}?`,
      choices: [
        { title: "pi-native  - pi installs and manages it", value: "pi-native" },
        { title: "skill      - copy a subfolder to ~/.pi/agent/skills/", value: "skill" },
        { title: "custom     - clone + custom build steps", value: "custom" },
      ],
    }, { onCancel: () => process.exit(0) });

    installType = type;

    if (type === "skill") {
      const { subpath } = await prompts({
        type: "text",
        name: "subpath",
        message: "Skill subpath in repo (leave empty for root):",
      }, { onCancel: () => process.exit(0) });
      resolvedSubpath = subpath || undefined;
    }

    if (type === "custom") {
      return await addCustomPackage(normalizedSource, rating);
    }
  }

  // Derive name
  const spec = normalizedSource.replace(/^(npm:|git:|local:)/, "");
  const rawName = resolvedSubpath
    ? resolvedSubpath.split("/").pop()!
    : spec.split("/").pop()?.split("@")[0] ?? spec;
  const name = rawName;

  const manifest = await loadManifest();
  if (manifest.packages[name]) {
    console.log(pc.yellow(`  ${name} is already in kit.yml (rating: ${manifest.packages[name].rating}).`));
    return;
  }

  console.log(pc.cyan(`  Installing ${name}...`));

  if (installType === "skill" || resolvedSubpath) {
    const { skillProvider } = await import("./providers.js");
    try {
      await skillProvider.install(name, {
        source: normalizedSource,
        rating,
        type: "skill",
        skill_subpath: resolvedSubpath,
      });
    } catch (e) {
      console.log(pc.red(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`));
      return;
    }
  } else {
    // pi-native: let pi handle it (npm or git)
    const result = await runCommand("pi", ["install", normalizedSource]);
    if (result.exitCode !== 0) {
      const raw = result.stderr.toString() + result.stdout.toString();
      const lines = raw.split("\n").map(l => l.replace(/^npm error /, "").trim()).filter(Boolean);
      const useful = lines.find(l => l.includes("404") || l.includes("403") || l.includes("Not found") || l.includes("failed"))
        ?? lines[0] ?? "install failed";
      console.log(pc.red(`  ❌ ${name}: ${useful}`));
      return;
    }
  }

  // Save to kit.yml
  const entry: PackageManifest = { source: normalizedSource, rating };
  if (installType && installType !== "pi-native") entry.type = installType;
  if (resolvedSubpath) entry.skill_subpath = resolvedSubpath;
  manifest.packages[name] = entry;
  await saveManifestFile(manifest);
  console.log(pc.green(`  ✅ ${name} added as ${rating}${installType === "skill" ? " (skill)" : ""}.`));
  await saveManifestFile(manifest);
  console.log(pc.green(`  ✅ ${name} added as ${rating}.`));

  // Push to gist
  try {
    const { pushManifest } = await import("./remote.js");
    const content = await readFile(kitYmlPath(), "utf-8");
    await pushManifest(content);
  } catch (e) {
    console.log(pc.yellow(`  ⚠  Could not push to gist: ${e instanceof Error ? e.message : e}`));
  }
}

export async function bootstrapManifestFromPi(): Promise<void> {
  if (existsSync(kitYmlPath())) return;

  let piListOutput = "";
  try {
    const result = await runCommand("pi", ["list"]);
    piListOutput = result.stdout.toString("utf8");
  } catch {
    console.log(pc.yellow("  ⚠ Pi not found or not installed. Creating empty kit.yml."));
  }

  const lines = piListOutput.split("\n");
  const manifest: KitManifest = {
    meta: { pi_version: undefined, home: "~" },
    packages: {},
    mcp_servers: {},
  };

  let currentSource: string | null = null;
  for (const line of lines) {
    if (line.startsWith("    ")) {
      if (currentSource) {
        const parts = line.trim().split("/");
        const name = parts[parts.length - 1]!;
        if (name && !manifest.packages[name]) manifest.packages[name] = { source: currentSource, rating: "useful" };
        currentSource = null;
      }
    } else if (line.startsWith("  ") && line.trim()) {
      currentSource = line.trim();
    }
  }

  try {
    const versionResult = await runCommand("pi", ["--version"]);
    const version = versionResult.exitCode === 0 ? versionResult.stdout.toString().trim() : null;
    if (version) manifest.meta.pi_version = version;
  } catch { /* ignore */ }

  await writeFile(kitYmlPath(), serializeManifest(manifest), "utf8");
  console.log(pc.green("  ✅ Created kit.yml with " + Object.keys(manifest.packages).length + " packages."));
}

// ─── Init command ───────────────────────────────────────────────
export async function init(): Promise<void> {
  const prompts = (await import("prompts")).default;

  // Ask if they want to bootstrap from a public gist
  const { fromGist } = await prompts({
    type: "confirm",
    name: "fromGist",
    message: "Bootstrap from someone's public gist? (e.g. a friend's config)",
    initial: false,
  }, { onCancel: () => process.exit(0) });

  if (fromGist) {
    const { ref } = await prompts({
      type: "text",
      name: "ref",
      message: "GitHub username or username/profile (e.g. fulgidus or fulgidus/work):",
    }, { onCancel: () => process.exit(0) });
    if (ref?.trim()) {
      await initFromPublicGist(ref.trim());
      return;
    }
  }

  console.log(pc.bold("\n  Bootstrapping kit.yml from current Pi installation...\n"));

  // Read pi list output
  let piListOutput = "";
  try {
    const result = await runCommand("pi", ["list"]);
    piListOutput = result.stdout.toString("utf8");
  } catch {
    console.log(pc.yellow("  ⚠ Pi not found or not installed. Creating empty kit.yml."));
  }

  // Parse: source lines (2 spaces indent) followed by path lines (4 spaces)
  const lines = piListOutput.split("\n");
  const manifest: KitManifest = {
    meta: { pi_version: undefined, home: "~" },
    packages: {},
    mcp_servers: {},
  };

  let currentSource: string | null = null;
  for (const line of lines) {
    if (line.startsWith("    ")) {
      // Path line - we have source + path, add to manifest
      if (currentSource) {
        const parts = line.trim().split("/");
        const name = parts[parts.length - 1]!;
        if (name && !manifest.packages[name]) {
          manifest.packages[name] = { source: currentSource, rating: "useful" };
        }
        currentSource = null;
      }
    } else if (line.startsWith("  ") && line.trim()) {
      currentSource = line.trim();
    }
  }

  // Get current pi version via pi --version (package-name-agnostic)
  try {
    const versionResult = await runCommand("pi", ["--version"]);
    const v = versionResult.exitCode === 0 ? versionResult.stdout.toString().trim() : null;
    if (v) manifest.meta.pi_version = v;
  } catch { /* ignore */ }

  const { serializeManifest } = await import("./manifest.js");
  const content = serializeManifest(manifest);
  await writeFile(kitYmlPath(), content, "utf-8");

  console.log(pc.green(`  ✅ Created kit.yml with ${Object.keys(manifest.packages).length} packages.`));
  console.log(pc.dim("  Review and adjust ratings, then run 'pd push' to save to your gist.\n"));
}

async function initFromPublicGist(ref: string): Promise<void> {
  // ref = "username" or "username/profile"
  const [user, profileName = "default"] = ref.split("/");
  const gistFile = "pi-depo.yml";
  const legacyFile = "pi_kit.yml";

  console.log(pc.dim(`  Searching for pi-depo-${profileName} gist by ${user}...`));

  // Search public gists by user
  const res = await fetch(`https://api.github.com/users/${user}/gists?per_page=100`);
  if (!res.ok) throw new Error(`Could not fetch gists for ${user}: ${res.status}`);

  const gists = await res.json() as Array<{ id: string; description: string; public: boolean; files: Record<string, { content?: string; raw_url: string }> }>;
  const target = gists.find(g =>
    (g.description === `pi-depo-${profileName}` || g.description === `pd - pi-depo config`) &&
    g.public &&
    (gistFile in g.files || legacyFile in g.files)
  );

  if (!target) {
    throw new Error(`No public pi-depo-${profileName} gist found for user ${user}.\n  Make sure their gist is public and named 'pi-depo-${profileName}'.`);
  }

  // Fetch content
  const fileEntry = target.files[gistFile] ?? target.files[legacyFile];
  const raw_url = fileEntry!.raw_url;
  const contentRes = await fetch(raw_url);
  if (!contentRes.ok) throw new Error(`Failed to fetch gist content: ${contentRes.status}`);
  const content = await contentRes.text();

  await writeFile(kitYmlPath(), content, "utf-8");
  console.log(pc.green(`  ✅ Imported config from ${user}'s pi-depo-${profileName} gist (${target.id}).`));
  console.log(pc.dim("  Review kit.yml, adjust to your needs, then run 'pd push' to save your own copy.\n"));

  // Offer to sync immediately
  const prompts = (await import("prompts")).default;
  const { doSync } = await prompts({
    type: "confirm",
    name: "doSync",
    message: "Sync now (install everything from this config)?",
    initial: true,
  }, { onCancel: () => process.exit(0) });
  if (doSync) await sync();
}
