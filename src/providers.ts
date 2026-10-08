import { formatCommandError, runCommand, runShellCommand } from "./process.js"
import type { PackageManifest, McpServerManifest, InstallType, PackageStatus } from "./types.js";
import { parseSource, expandTemplate } from "./manifest.js";
import { templateVars, piSkillsDir } from "./config.js";
import { mergeIntoJsonFile } from "./merge.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { cpSync, mkdirSync } from "node:fs";

// ─── Provider interface ─────────────────────────────────────────
export interface Provider {
  install(name: string, pkg: PackageManifest | McpServerManifest): Promise<void>;
  remove(name: string, pkg: PackageManifest | McpServerManifest): Promise<void>;
  verify(name: string, pkg: PackageManifest | McpServerManifest): Promise<boolean>;
  status(name: string, pkg: PackageManifest | McpServerManifest): Promise<PackageStatus>;
}

// ─── Pi-Native Provider ─────────────────────────────────────────
export const piNativeProvider: Provider = {
  async install(name: string, pkg: PackageManifest): Promise<void> {
    const source = expandTemplate(pkg.source, templateVars());
    try {
      const result = await runCommand("pi", ["install", source]);
      if (result.exitCode !== 0) throw formatCommandError("pi", ["install", source], result);
    } catch (e) {
      throw new Error(`pi install failed for ${name}: ${e}`);
    }
  },

  async remove(_name: string, pkg: PackageManifest): Promise<void> {
    try {
      // pi tracks packages by their source specifier (e.g. npm:pi-mcp-adapter),
      // not by the short name - use source for removal
      const source = expandTemplate(pkg.source, templateVars());
      await runCommand("pi", ["remove", source]);
    } catch {
      // ignore
    }
  },

  async verify(name: string, _pkg: PackageManifest): Promise<boolean> {
    try {
      const result = await runCommand("pi", ["list"]);
      if (result.exitCode !== 0) return false;
      const output = result.stdout.toString("utf8");
      return output.includes(name);
    } catch {
      return false;
    }
  },

  async status(name: string, pkg: PackageManifest): Promise<PackageStatus> {
    const isInstalled = await piNativeProvider.verify(name, pkg);
    if (pkg.rating === "disabled") {
      return isInstalled ? "disabled" : "disabled";
    }
    return isInstalled ? "synced" : "missing";
  },
};

// ─── Custom Provider ────────────────────────────────────────────
export const customProvider: Provider = {
  async install(name: string, pkg: PackageManifest): Promise<void> {
    const vars = templateVars();

    // Resolve {{source}} to the actual URL/path so steps can use it
    const parsedSource = parseSource(expandTemplate(pkg.source, vars));
    const sourceUrl = parsedSource.type === "git"
      ? (parsedSource.spec.includes("://") ? parsedSource.spec : `https://${parsedSource.spec}`)
      : parsedSource.spec;
    vars.source = sourceUrl;

    const steps = pkg.steps;
    if (!steps) throw new Error(`Custom package ${name} has no steps`);

    // Execute steps in order
    const stepOrder = ["clone", "build", "postinstall"];
    for (const stepName of stepOrder) {
      const cmd = steps[stepName];
      if (!cmd) continue;
      const expanded = expandTemplate(cmd, vars);

      // For clone step: skip if destination already exists
      if (stepName === "clone") {
        const parts = expanded.trim().split(/\s+/);
        const dest = parts[parts.length - 1];
        if (dest && existsSync(dest)) {
          console.log(`  [clone] skipped - ${dest} already exists`);
          continue;
        }
      }

      console.log(`  [${stepName}] executing`);
      try {
        const result = await runShellCommand(expanded);
        if (result.exitCode !== 0) throw new Error(`Step '${stepName}' failed (exit ${result.exitCode})`);
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : `Step '${stepName}' failed for ${name}: ${e}`);
      }
    }

    // Config merge
    if (pkg.config_merge) {
      const target = expandTemplate(pkg.config_merge.target, vars);
      const jsonStr = expandTemplate(pkg.config_merge.json, vars);
      let jsonPatch: Record<string, unknown>;
      try {
        jsonPatch = JSON.parse(jsonStr);
      } catch {
        throw new Error(`Invalid JSON in config_merge for ${name}`);
      }
      await mergeIntoJsonFile(target, jsonPatch);
    }
  },

  async remove(_name: string, pkg: PackageManifest): Promise<void> {
    // Custom removal: we try to remove the cloned dir
    // This is best-effort since custom packages may spread files
    const vars = templateVars();
    if (pkg.steps?.clone) {
      // Try to identify the clone destination from the clone step
      const cloneCmd = expandTemplate(pkg.steps.clone, vars);
      const parts = cloneCmd.split(/\s+/);
      const lastPart = parts[parts.length - 1];
      if (lastPart && existsSync(lastPart)) {
        const { rmSync } = await import("node:fs");
        rmSync(lastPart, { recursive: true, force: true });
      }
    }

    // Remove config_merge entries if specified
    if (pkg.config_merge) {
      const jsonStr = expandTemplate(pkg.config_merge.json, vars);
      try {
        const jsonPatch = JSON.parse(jsonStr);
        // Collect dot-paths to remove
        const paths = collectLeafPaths(jsonPatch);
        const { removeKeysFromJson } = await import("./merge.js");
        const target = expandTemplate(pkg.config_merge.target, vars);
        await removeKeysFromJson(target, paths);
      } catch {
        // best effort
      }
    }
  },

  async verify(_name: string, pkg: PackageManifest): Promise<boolean> {
    if (!pkg.verify) return false;
    const vars = templateVars();
    const cmd = expandTemplate(pkg.verify.check, vars);
    try {
      const result = await runShellCommand(cmd);
      if (result.exitCode !== 0) return false;
      return true;
    } catch {
      return false;
    }
  },

  async status(name: string, pkg: PackageManifest): Promise<PackageStatus> {
    if (pkg.rating === "disabled") return "disabled";
    const verified = await customProvider.verify(name, pkg);
    return verified ? "synced" : "missing";
  },
};

// ─── Skill Provider ─────────────────────────────────────────────
export const skillProvider: Provider = {
  async install(name: string, pkg: PackageManifest): Promise<void> {
    const vars = templateVars();
    const source = parseSource(expandTemplate(pkg.source, vars));
    const target = pkg.target ? expandTemplate(pkg.target, vars) : join(piSkillsDir(), name);

    if (source.type === "git") {
      // Clone to temp, then copy subpath
      const tmpDir = `/tmp/pd-skill-${name}-${Date.now()}`;
      const gitUrl = source.spec.includes("://")
        ? source.spec
        : `https://${source.spec}`;

      try {
        const gitArgs = ["clone", "--depth", "1"];
        if (source.ref) gitArgs.push("--branch", source.ref);
        gitArgs.push(gitUrl, tmpDir);
        const result = await runCommand("git", gitArgs);
        if (result.exitCode !== 0) throw formatCommandError("git", gitArgs, result);
      } catch (e) {
        throw new Error(`git clone failed for skill ${name}: ${e}`);
      }

      const srcPath = pkg.skill_subpath
        ? join(tmpDir, pkg.skill_subpath)
        : tmpDir;

      if (!existsSync(srcPath)) {
        throw new Error(`Skill subpath not found: ${srcPath}`);
      }

      mkdirSync(join(target, ".."), { recursive: true });
      cpSync(srcPath, target, { recursive: true });

      // Cleanup
      const { rmSync } = await import("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    } else if (source.type === "local") {
      const srcPath = expandTemplate(source.spec, vars);
      cpSync(srcPath, target, { recursive: true });
    }
  },

  async remove(name: string, pkg: PackageManifest): Promise<void> {
    const vars = templateVars();
    const target = pkg.target ? expandTemplate(pkg.target, vars) : join(piSkillsDir(), name);
    if (existsSync(target)) {
      const { rmSync } = await import("node:fs");
      rmSync(target, { recursive: true, force: true });
    }
  },

  async verify(name: string, pkg: PackageManifest): Promise<boolean> {
    const vars = templateVars();
    const target = pkg.target ? expandTemplate(pkg.target, vars) : join(piSkillsDir(), name);
    return existsSync(join(target, "SKILL.md"));
  },

  async status(name: string, pkg: PackageManifest): Promise<PackageStatus> {
    if (pkg.rating === "disabled") return "disabled";
    const verified = await skillProvider.verify(name, pkg);
    return verified ? "synced" : "missing";
  },
};

// ─── MCP Server Provider ────────────────────────────────────────
export const mcpServerProvider: Provider = {
  async install(name: string, mcp: McpServerManifest): Promise<void> {
    const vars = templateVars();
    const source = parseSource(expandTemplate(mcp.source, vars));

    // Install the server binary/package
    if (source.type === "npm") {
      try {
        const result = await runCommand("npm", ["install", "-g", source.spec]);
        if (result.exitCode !== 0) throw formatCommandError("npm", ["install", "-g", source.spec], result);
      } catch (e) {
        throw new Error(`npm install -g failed for MCP ${name}: ${e}`);
      }
    }
    // git and local sources: assume the binary is already available
    // or will be installed by a custom step

    // Build MCP config entry
    const command = source.type === "npm"
      ? "npx"
      : source.type === "local"
        ? expandTemplate(source.spec, vars)
        : "node"; // git sources typically need node

    const args = mcp.args ?? (source.type === "npm" ? [source.spec] : []);

    // Resolve env vars
    const resolvedEnv: Record<string, string> = {};
    if (mcp.env) {
      for (const [key, value] of Object.entries(mcp.env)) {
        if (value.startsWith("env:")) {
          const envVar = value.slice(4);
          const resolved = process.env[envVar];
          if (resolved) {
            resolvedEnv[key] = resolved;
          } else {
            console.warn(`  ⚠ Env var ${envVar} not set for MCP ${name}.${key}`);
          }
        } else {
          resolvedEnv[key] = value;
        }
      }
    }

    // Merge into mcp.json
    const mcpEntry: Record<string, unknown> = {
      command,
      args,
    };
    if (Object.keys(resolvedEnv).length > 0) {
      mcpEntry.env = resolvedEnv;
    }

    const { piMcpPath } = await import("./config.js");
    await mergeIntoJsonFile(piMcpPath(), {
      mcpServers: {
        [name]: mcpEntry,
      },
    });
  },

  async remove(name: string, _mcp: McpServerManifest): Promise<void> {
    // Remove from mcp.json
    const { removeKeysFromJson } = await import("./merge.js");
    const { piMcpPath } = await import("./config.js");
    await removeKeysFromJson(piMcpPath(), [`mcpServers.${name}`]);
  },

  async verify(name: string, mcp: McpServerManifest): Promise<boolean> {
    if (mcp.verify) {
      const vars = templateVars();
      const cmd = expandTemplate(mcp.verify.check, vars);
      try {
        const result = await runShellCommand(cmd);
        if (result.exitCode !== 0) return false;
        return true;
      } catch {
        return false;
      }
    }
    // Default verify: check if mcp.json has the entry
    const { readFile } = await import("node:fs/promises");
    const { piMcpPath } = await import("./config.js");
    const { existsSync } = await import("node:fs");
    if (!existsSync(piMcpPath())) return false;
    try {
      const content = await readFile(piMcpPath(), "utf-8");
      const data = JSON.parse(content);
      return !!(data.mcpServers && data.mcpServers[name]);
    } catch {
      return false;
    }
  },

  async status(name: string, mcp: McpServerManifest): Promise<PackageStatus> {
    if (mcp.rating === "disabled") return "disabled";
    const verified = await mcpServerProvider.verify(name, mcp);
    return verified ? "synced" : "missing";
  },
};

// ─── Provider resolver ──────────────────────────────────────────
export function getProvider(type: InstallType): Provider {
  switch (type) {
    case "pi-native":
      return piNativeProvider;
    case "custom":
      return customProvider;
    case "skill":
      return skillProvider;
    case "mcp-server":
      return mcpServerProvider;
  }
}

// ─── Helpers ────────────────────────────────────────────────────
function collectLeafPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      paths.push(...collectLeafPaths(value as Record<string, unknown>, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}
