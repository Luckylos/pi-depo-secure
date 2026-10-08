import { describe, expect, it } from "vitest";
import { sanitizeConfig } from "../src/config.js";
import { tokenForProvider } from "../src/remote.js";

describe("credential handling", () => {
  it("removes legacy tokens before configuration is serialized", () => {
    const safe = sanitizeConfig({ auth: { github_token: "secret-token" }, active_profile: "default" });
    expect(safe).toEqual({ active_profile: "default" });
    expect(JSON.stringify(safe)).not.toContain("secret-token");
  });

  it("reads GitHub credentials from the environment without persistence", async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try { await expect(tokenForProvider("github")).resolves.toBe("test-token"); }
    finally { if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous; }
  });
});
