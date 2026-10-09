
import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { authenticateGithub, githubAuthStatus, githubEnvironmentToken, githubLoginArgs } from "../src/github-auth.js";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("GitHub authentication", () => {
  it("accepts an environment token without invoking gh", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    const status = await githubAuthStatus();
    expect(status).toMatchObject({ authenticated: true, source: "environment" });
  });

  it("falls back to gh auth token when gh status is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-auth-test-"));
    roots.push(root);
    const gh = join(root, "gh");
    await writeFile(gh, "#!/bin/sh\n" +
      "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then exit 1; fi\n" +
      "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"token\" ]; then printf test-token; exit 0; fi\n" +
      "exit 1\n");
    await chmod(gh, 0o700);
    process.env.PATH = root + delimiter + (originalPath ?? "");
    const status = await githubAuthStatus();
    expect(status).toMatchObject({ authenticated: true, source: "gh" });
  });

  it("reports a clear missing-gh state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-auth-test-"));
    roots.push(root);
    process.env.PATH = root;
    const status = await githubAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.detail).toMatch(/GitHub CLI.*install|gh.*install/i);
  });

  it("uses the browser/device login flow without accepting a token argument", () => {
    expect(githubLoginArgs()).toEqual(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--scopes", "gist", "--web"]);
  });

  it("falls back to GH_TOKEN when GITHUB_TOKEN is empty", async () => {
    expect(githubEnvironmentToken({ GITHUB_TOKEN: "  ", GH_TOKEN: "fallback-token" })).toBe("fallback-token");
    process.env.GITHUB_TOKEN = "  ";
    process.env.GH_TOKEN = "fallback-token";
    await expect(githubAuthStatus()).resolves.toMatchObject({ authenticated: true, source: "environment" });
  });

  it("completes the web/device login and rechecks authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-auth-test-"));
    roots.push(root);
    const state = join(root, "authenticated");
    const gh = join(root, "gh");
    await writeFile(gh, "#!/bin/sh\n" +
      "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then test -f \"$GH_FAKE_STATE\"; exit $?; fi\n" +
      "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"token\" ]; then test -f \"$GH_FAKE_STATE\" || exit 1; printf fake-token; exit 0; fi\n" +
      "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"login\" ]; then touch \"$GH_FAKE_STATE\"; printf \"https://github.com/login/device\nABCD-EFGH\n\"; exit 0; fi\n" +
      "exit 1\n");
    await chmod(gh, 0o700);
    process.env.PATH = root + delimiter + (originalPath ?? "");
    process.env.GH_FAKE_STATE = state;
    const output: string[] = [];
    const status = await authenticateGithub({ timeoutMs: 10_000, onOutput: (chunk) => output.push(chunk) });
    expect(status.authenticated).toBe(true);
    expect(output.join("")).toContain("login/device");
    delete process.env.GH_FAKE_STATE;
  });
});
