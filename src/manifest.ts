import yaml from "js-yaml";
import type {
  KitManifest,
  PackageManifest,
  McpServerManifest,
  RemoteConfig,
  Rating,
  InstallType,
} from "./types.js";

// ─── Parse source string into typed object ──────────────────────
export function parseSource(raw: string): { type: "npm" | "git" | "local"; spec: string; ref?: string } {
  if (raw.startsWith("npm:")) {
    return { type: "npm", spec: raw.slice(4) };
  }
  if (raw.startsWith("git:")) {
    const rest = raw.slice(4);
    const atIdx = rest.lastIndexOf("@");
    if (atIdx > 0 && !rest.startsWith("http")) {
      return { type: "git", spec: rest.slice(0, atIdx), ref: rest.slice(atIdx + 1) };
    }
    return { type: "git", spec: rest };
  }
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("ssh://")) {
    const atIdx = raw.lastIndexOf("@");
    if (atIdx > 8) { // past the protocol
      return { type: "git", spec: raw.slice(0, atIdx), ref: raw.slice(atIdx + 1) };
    }
    return { type: "git", spec: raw };
  }
  if (raw.startsWith("local:")) {
    return { type: "local", spec: raw.slice(6) };
  }
  // Bare github.com/user/repo → assume git
  if (raw.includes("/") && !raw.startsWith("/") && !raw.startsWith(".")) {
    const atIdx = raw.lastIndexOf("@");
    if (atIdx > 0) {
      return { type: "git", spec: raw.slice(0, atIdx), ref: raw.slice(atIdx + 1) };
    }
    return { type: "git", spec: raw };
  }
  // Fallback: treat as local path
  return { type: "local", spec: raw };
}

// ─── Infer install type from package manifest ───────────────────
export function inferInstallType(pkg: PackageManifest | McpServerManifest): InstallType {
  if ("type" in pkg && pkg.type) return pkg.type;
  // MCP servers are always mcp-server type
  // Packages with steps are custom
  if ("steps" in pkg && pkg.steps) return "custom";
  if ("skill_subpath" in pkg && pkg.skill_subpath) return "skill";
  return "pi-native";
}

// ─── Template expansion ─────────────────────────────────────────
export function expandTemplate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

// ─── Validate manifest ──────────────────────────────────────────
export interface ValidationError {
  path: string;
  message: string;
}

export function validateManifest(manifest: KitManifest): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!manifest.meta) {
    errors.push({ path: "meta", message: "Missing meta section" });
  }

  for (const [name, pkg] of Object.entries(manifest.packages ?? {})) {
    const path = `packages.${name}`;

    if (!pkg.source) {
      errors.push({ path: `${path}.source`, message: "Missing source" });
    }

    if (pkg.rating && !["core", "useful", "debatable", "disabled"].includes(pkg.rating)) {
      errors.push({ path: `${path}.rating`, message: `Invalid rating: ${pkg.rating}` });
    }

    const installType = inferInstallType(pkg);

    if (installType === "custom" && !pkg.steps) {
      errors.push({ path: `${path}.steps`, message: "Custom package requires steps" });
    }

    if (installType === "custom" && pkg.steps && !pkg.verify) {
      // Warning, not error - but we surface it
      errors.push({ path: `${path}.verify`, message: "Custom package without verify check (recommended)" });
    }

    if (installType === "skill" && !pkg.target) {
      errors.push({ path: `${path}.target`, message: "Skill package requires target path" });
    }

    if (pkg.rating === "disabled" && !pkg.reason) {
      errors.push({ path: `${path}.reason`, message: "Disabled package should have a reason" });
    }
  }

  for (const [name, mcp] of Object.entries(manifest.mcp_servers ?? {})) {
    const path = `mcp_servers.${name}`;

    if (!mcp.source) {
      errors.push({ path: `${path}.source`, message: "Missing source" });
    }

    if (mcp.rating === "disabled" && !mcp.reason) {
      errors.push({ path: `${path}.reason`, message: "Disabled MCP server should have a reason" });
    }
  }

  return errors;
}

// ─── Parse kit.yml ──────────────────────────────────────────────
export function parseManifest(content: string): KitManifest {
  const raw = yaml.load(content) as Record<string, unknown>;

  const meta = (raw.meta ?? {}) as KitManifest["meta"];
  const remote = raw.remote as RemoteConfig | undefined;
  const packages = (raw.packages ?? {}) as Record<string, PackageManifest>;
  const mcp_servers = (raw.mcp_servers ?? raw.mcpServers ?? {}) as Record<string, McpServerManifest>;

  return { meta, remote, packages, mcp_servers };
}

// ─── Serialize kit.yml ──────────────────────────────────────────
export function serializeManifest(manifest: KitManifest): string {
  // Reconstruct in a clean format for YAML output
  const output: Record<string, unknown> = {
    meta: manifest.meta,
  };

  if (manifest.remote) {
    output.remote = manifest.remote;
  }

  output.packages = manifest.packages;

  if (Object.keys(manifest.mcp_servers).length > 0) {
    output.mcp_servers = manifest.mcp_servers;
  }

  return yaml.dump(output, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}
