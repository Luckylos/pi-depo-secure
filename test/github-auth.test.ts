
import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { authenticateGithub, githubAuthStatus, githubEnvironmentToken, githubLoginArgs, githubTokenFromAuth, type GitHubTokenStore } from "../src/github-auth.js";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.PI_GITHUB_OAUTH_CLIENT_ID;
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
    expect(status.detail).toMatch(/GitHub authentication.*unavailable|Install gh|gh.*install/i);
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

  it("uses a keychain token when gh is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-auth-test-"));
    roots.push(root);
    const tokenStore: GitHubTokenStore = { get: async () => "keychain-token", set: async () => {} };
    const status = await githubAuthStatus({ env: { PATH: root }, tokenStore, commandExists: async () => false });
    expect(status).toMatchObject({ authenticated: true, source: "keychain" });
  });

  it("resolves API credentials from the keychain without gh", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-auth-test-"));
    roots.push(root);
    const tokenStore: GitHubTokenStore = { get: async () => "keychain-api-token", set: async () => {} };
    await expect(githubTokenFromAuth({ env: { PATH: root }, tokenStore, commandExists: async () => false })).resolves.toBe("keychain-api-token");
  });

  it("completes GitHub Device Flow without gh and stores the token in the keychain", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-auth-test-"));
    roots.push(root);
    const stored: string[] = [];
    const tokenStore: GitHubTokenStore = { get: async () => undefined, set: async (token) => { stored.push(token); } };
    const responses = [
      { device_code: "device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
      { error: "authorization_pending" },
      { access_token: "secret-access-token", token_type: "bearer", scope: "gist" },
    ];
    const calls: Array<{ url: string; body: string }> = [];
    const waits: number[] = [];
    const output: string[] = [];
    const status = await authenticateGithub({
      env: { PATH: root, PI_GITHUB_OAUTH_CLIENT_ID: "public-client-id" },
      tokenStore,
      commandExists: async () => false,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body ?? "") });
        return { ok: true, status: 200, json: async () => responses.shift() } as Response;
      },
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      onOutput: (chunk) => output.push(chunk),
    });

    expect(status).toMatchObject({ authenticated: true, source: "keychain" });
    expect(stored).toEqual(["secret-access-token"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      "https://github.com/login/oauth/access_token",
    ]);
    expect(calls[0]?.body).toContain("client_id=public-client-id");
    expect(calls[0]?.body).toContain("scope=gist");
    expect(waits).toEqual([5000]);
    expect(output.join(" ")).toContain("ABCD-EFGH");
    expect(output.join(" ")).not.toContain("secret-access-token");
  });

  it("honors GitHub slow_down polling responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-auth-test-"));
    roots.push(root);
    const stored: string[] = [];
    const tokenStore: GitHubTokenStore = { get: async () => undefined, set: async (token) => { stored.push(token); } };
    const responses = [
      { device_code: "device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
      { error: "slow_down", interval: 10 },
      { access_token: "slow-token", token_type: "bearer", scope: "gist" },
    ];
    const waits: number[] = [];
    await expect(authenticateGithub({
      env: { PATH: root, PI_GITHUB_OAUTH_CLIENT_ID: "public-client-id" },
      tokenStore,
      commandExists: async () => false,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => responses.shift() } as Response),
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    })).resolves.toMatchObject({ authenticated: true, source: "keychain" });
    expect(waits).toEqual([10_000]);
    expect(stored).toEqual(["slow-token"]);
  });

  it("explains the client ID requirement when gh and tokens are unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-auth-test-"));
    roots.push(root);
    const tokenStore: GitHubTokenStore = { get: async () => undefined, set: async () => {} };
    await expect(authenticateGithub({ env: { PATH: root }, tokenStore, commandExists: async () => false })).rejects.toThrow(/PI_GITHUB_OAUTH_CLIENT_ID/);
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
