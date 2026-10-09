import { afterEach, describe, expect, it } from "vitest";
import { authenticateGithub, githubAuthStatus, githubTokenFromAuth, type GitHubTokenStore } from "../src/github-auth.js";

const emptyTokenStore = (): GitHubTokenStore => ({ get: async () => undefined, set: async () => {} });

afterEach(() => {
  delete process.env.PI_GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

describe("GitHub authentication", () => {
  it("uses the system keychain token", async () => {
    const tokenStore: GitHubTokenStore = { get: async () => "keychain-token", set: async () => {} };
    const status = await githubAuthStatus({ tokenStore });
    expect(status).toMatchObject({ authenticated: true, source: "keychain" });
  });

  it("resolves API credentials only from the system keychain", async () => {
    const tokenStore: GitHubTokenStore = { get: async () => "keychain-api-token", set: async () => {} };
    await expect(githubTokenFromAuth({ tokenStore })).resolves.toBe("keychain-api-token");
  });

  it("does not accept environment tokens as an alternate login path", async () => {
    process.env.GITHUB_TOKEN = "environment-token";
    process.env.GH_TOKEN = "fallback-token";
    const tokenStore = emptyTokenStore();
    const status = await githubAuthStatus({ tokenStore });
    expect(status.authenticated).toBe(false);
    await expect(githubTokenFromAuth({ tokenStore })).rejects.toThrow(/No GitHub authorization|PI_GITHUB_OAUTH_CLIENT_ID|keychain/i);
  });

  it("completes GitHub Device Flow and stores the token in the keychain", async () => {
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
      env: { PI_GITHUB_OAUTH_CLIENT_ID: "public-client-id" },
      tokenStore,
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
    const stored: string[] = [];
    const tokenStore: GitHubTokenStore = { get: async () => undefined, set: async (token) => { stored.push(token); } };
    const responses = [
      { device_code: "device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
      { error: "slow_down", interval: 10 },
      { access_token: "slow-token", token_type: "bearer", scope: "gist" },
    ];
    const waits: number[] = [];
    await expect(authenticateGithub({
      env: { PI_GITHUB_OAUTH_CLIENT_ID: "public-client-id" },
      tokenStore,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => responses.shift() } as Response),
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    })).resolves.toMatchObject({ authenticated: true, source: "keychain" });
    expect(waits).toEqual([10_000]);
    expect(stored).toEqual(["slow-token"]);
  });

  it("requires an OAuth Client ID for the direct Device Flow", async () => {
    await expect(authenticateGithub({ tokenStore: emptyTokenStore(), env: {} })).rejects.toThrow(/PI_GITHUB_OAUTH_CLIENT_ID/);
  });

  it("reports an unavailable system keychain without suggesting alternate login paths", async () => {
    const tokenStore: GitHubTokenStore = { get: async () => { throw new Error("keychain unavailable"); }, set: async () => {} };
    const status = await githubAuthStatus({ tokenStore });
    expect(status.authenticated).toBe(false);
    expect(status.detail).toMatch(/keychain/i);
    expect(status.detail).not.toMatch(/gh|GITHUB_TOKEN|GH_TOKEN/);
  });
});
