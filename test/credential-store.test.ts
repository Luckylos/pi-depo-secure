import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitHubTokenStore } from "../src/github-auth.js";
import { defaultGitHubCredentialDirectory, portableGitHubTokenStore } from "../src/credential-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("portable GitHub credential store", () => {
  it("round-trips an encrypted token without writing plaintext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-github-credentials-"));
    roots.push(directory);
    const store = portableGitHubTokenStore({ directory });
    await store.set("secret-access-token");

    await expect(store.get()).resolves.toBe("secret-access-token");
    const files = ["github-token.key", "github-token.enc"];
    for (const name of files) {
      const content = await readFile(join(directory, name), "utf8");
      expect(content).not.toContain("secret-access-token");
      if (process.platform !== "win32") expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("uses the platform user configuration directory", () => {
    const directory = defaultGitHubCredentialDirectory({ APPDATA: "C:\\Users\\test\\AppData\\Roaming", XDG_CONFIG_HOME: "/tmp/test-xdg" });
    expect(directory).toMatch(/pi-depo-secure$/);
    expect(directory).not.toContain(".pi");
  });

  it("makes the direct auth store use the requested directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-github-default-"));
    roots.push(directory);
    const store = defaultGitHubTokenStore({ directory });
    await store.set("default-store-token");
    await expect(store.get()).resolves.toBe("default-store-token");
    await expect(readFile(join(directory, "github-token.enc"), "utf8")).resolves.not.toContain("default-store-token");
  });

  it("returns no token before first authentication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-github-credentials-"));
    roots.push(directory);
    await expect(portableGitHubTokenStore({ directory }).get()).resolves.toBeUndefined();
  });

  it("rejects an incomplete credential store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-github-credentials-"));
    roots.push(directory);
    const store = portableGitHubTokenStore({ directory });
    await store.set("secret-access-token");
    await rm(join(directory, "github-token.key"));
    await expect(store.get()).rejects.toThrow(/credential store/i);
  });
});
