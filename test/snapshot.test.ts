import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshot, diffSnapshots, applySnapshot } from "../src/snapshot.js";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-depo-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("configuration snapshots", () => {
  it("collects deterministic files and preserves modes", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "agents"));
    await writeFile(join(root, "settings.json"), "{}", { mode: 0o640 });
    await writeFile(join(root, "agents", "z.md"), "z");
    await writeFile(join(root, "agents", "a.md"), "a");
    const snapshot = await collectSnapshot(root, ["settings.json", "agents"]);
    expect(snapshot.map((entry) => entry.path)).toEqual(["agents/a.md", "agents/z.md", "settings.json"]);
    expect(snapshot.find((entry) => entry.path === "settings.json")?.mode).toBe(0o640);
  });

  it("rejects traversal, symlinks, and oversized files", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "secret"), "secret");
    await symlink("secret", join(root, "link"));
    await expect(collectSnapshot(root, ["../secret"])).rejects.toThrow(/path/i);
    await expect(collectSnapshot(root, ["link"])).rejects.toThrow(/symlink/i);
    await expect(collectSnapshot(root, ["secret"], [], { maxFileBytes: 2 })).rejects.toThrow(/size/i);
  });

  it("computes content and mode changes without revealing contents", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "same"), "same");
    const before = await collectSnapshot(root, ["same"]);
    await writeFile(join(root, "same"), "changed", { mode: 0o600 });
    await writeFile(join(root, "added"), "new");
    const after = await collectSnapshot(root, ["same", "added"]);
    const diff = diffSnapshots(before, after);
    expect(diff.added.map((entry) => entry.path)).toEqual(["added"]);
    expect(diff.modified.map((entry) => entry.path)).toEqual(["same"]);
    expect(diff.deleted).toEqual([]);
    expect(JSON.stringify(diff)).not.toContain("changed");
  });

  it("does not prune unmanaged files by default", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "agents"));
    await writeFile(join(root, "agents", "old.md"), "old");
    const incoming = [{ path: "agents/new.md", mode: 0o644, sha256: "", contentBase64: Buffer.from("new").toString("base64") }];
    await applySnapshot(root, incoming);
    expect(await readFile(join(root, "agents", "old.md"), "utf8")).toBe("old");
    expect(await readFile(join(root, "agents", "new.md"), "utf8")).toBe("new");
  });
});
