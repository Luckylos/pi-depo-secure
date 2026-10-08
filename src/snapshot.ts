import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizeSnapshotEntries, type SnapshotEntry, snapshotLimits } from "./crypto.js";

export interface SnapshotLimits { maxFileBytes?: number; maxTotalBytes?: number }
export interface SnapshotDiff { added: SnapshotEntry[]; modified: SnapshotEntry[]; deleted: string[] }
export class SnapshotSecurityError extends Error {}

function validateRelativePath(value: string): void {
  if (!value || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:[\/]/.test(value) || value.includes("\\")) throw new SnapshotSecurityError("Unsafe snapshot path: " + value);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new SnapshotSecurityError("Unsafe snapshot path: " + value);
}

function resolveInside(root: string, value: string): string {
  validateRelativePath(value);
  const candidate = resolve(root, value);
  const rootWithSlash = resolve(root) + "/";
  if (candidate !== resolve(root) && !candidate.startsWith(rootWithSlash)) throw new SnapshotSecurityError("Path escapes snapshot root");
  return candidate;
}

function excluded(path: string, excludes: string[]): boolean {
  return excludes.some((item) => path === item || path.startsWith(item + "/"));
}

async function walk(root: string, absolute: string, relativePath: string, excludes: string[], output: SnapshotEntry[], limits: Required<SnapshotLimits>, total: { value: number }): Promise<void> {
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new SnapshotSecurityError("Symlinks are not allowed: " + relativePath);
  if (info.isDirectory()) {
    const children = (await readdir(absolute, { withFileTypes: true })).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
    for (const child of children) {
      const childRelative = relativePath ? relativePath + "/" + child : child;
      if (!excluded(childRelative, excludes)) await walk(root, join(absolute, child), childRelative, excludes, output, limits, total);
    }
    return;
  }
  if (!info.isFile()) throw new SnapshotSecurityError("Special files are not allowed: " + relativePath);
  if (info.size > limits.maxFileBytes) throw new SnapshotSecurityError("File exceeds size limit: " + relativePath);
  total.value += info.size;
  if (total.value > limits.maxTotalBytes) throw new SnapshotSecurityError("Snapshot exceeds total size limit");
  const content = await readFile(absolute);
  output.push({ path: relativePath, mode: info.mode & 0o777, sha256: createHash("sha256").update(content).digest("hex"), contentBase64: content.toString("base64") });
}

export async function collectSnapshot(root: string, includes: string[], excludes: string[] = [], limits: SnapshotLimits = {}): Promise<SnapshotEntry[]> {
  const resolvedRoot = resolve(root);
  const effective = { maxFileBytes: limits.maxFileBytes ?? snapshotLimits.maxEntryBytes, maxTotalBytes: limits.maxTotalBytes ?? snapshotLimits.maxTotalBytes };
  const output: SnapshotEntry[] = [];
  const total = { value: 0 };
  for (const include of includes) {
    validateRelativePath(include);
    if (excluded(include, excludes)) continue;
    const absolute = resolveInside(resolvedRoot, include);
    try { await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await walk(resolvedRoot, absolute, include, excludes, output, effective, total);
  }
  return normalizeSnapshotEntries(output);
}

export function diffSnapshots(before: SnapshotEntry[], after: SnapshotEntry[]): SnapshotDiff {
  const oldMap = new Map(before.map((entry) => [entry.path, entry]));
  const newMap = new Map(after.map((entry) => [entry.path, entry]));
  const added: SnapshotEntry[] = [];
  const modified: SnapshotEntry[] = [];
  const deleted: string[] = [];
  for (const [path, entry] of newMap) {
    const old = oldMap.get(path);
    if (!old) added.push(entry);
    else if (old.sha256 !== entry.sha256 || old.mode !== entry.mode) modified.push(entry);
  }
  for (const path of oldMap.keys()) if (!newMap.has(path)) deleted.push(path);
  return { added, modified, deleted };
}

async function ensureParentSafe(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new SnapshotSecurityError("Unsafe parent path: " + relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
}

export async function applySnapshot(root: string, entries: SnapshotEntry[], options: { prune?: boolean; managedPaths?: string[] } = {}): Promise<void> {
  const resolvedRoot = resolve(root);
  const normalized = normalizeSnapshotEntries(entries);
  await mkdir(resolvedRoot, { recursive: true });
  const stage = await mkdtemp(join(dirname(resolvedRoot), ".pi-depo-stage-"));
  try {
    for (const entry of normalized) {
      await ensureParentSafe(stage, entry.path);
      const staged = join(stage, entry.path);
      await writeFile(staged, Buffer.from(entry.contentBase64, "base64"), { mode: entry.mode });
    }
    for (const entry of normalized) {
      await ensureParentSafe(resolvedRoot, entry.path);
      const target = join(resolvedRoot, entry.path);
      try { if ((await lstat(target)).isSymbolicLink()) throw new SnapshotSecurityError("Refusing to overwrite symlink: " + entry.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const temp = target + ".pi-depo-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
      await rename(join(stage, entry.path), temp);
      await rename(temp, target);
    }
    if (options.prune) {
      if (!options.managedPaths?.length) throw new Error("Pruning requires managedPaths");
      const current = await collectSnapshot(resolvedRoot, options.managedPaths);
      const incoming = new Set(normalized.map((entry) => entry.path));
      for (const entry of current) if (!incoming.has(entry.path)) await rm(resolveInside(resolvedRoot, entry.path), { force: true });
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
