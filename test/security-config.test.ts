import { describe, expect, it } from "vitest";
import { sanitizeConfig } from "../src/config.js";

describe("credential handling", () => {
  it("removes legacy tokens before configuration is serialized", () => {
    const safe = sanitizeConfig({ auth: { github_token: "secret-token" }, active_profile: "default" });
    expect(safe).toEqual({ active_profile: "default" });
    expect(JSON.stringify(safe)).not.toContain("secret-token");
  });

});
