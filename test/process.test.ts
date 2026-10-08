import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageStatus } from "../src/config-sync.js";
import { runCommand } from "../src/process.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.PI_DEPO_CLI_PATH;
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("process execution", () => {
  it("passes arguments without a shell", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "$(touch /tmp/pi-depo-should-not-exist)"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("$(touch /tmp/pi-depo-should-not-exist)");
  });

  it("returns a structured failure for missing commands", async () => {
    const result = await runCommand("pi-command-that-does-not-exist", []);
    expect(result.exitCode).toBe(-1);
    expect(result.errorCode).toBe("ENOENT");
  });

  it("runs package operations through the bundled CLI path rather than PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-depo-process-test-"));
    roots.push(root);
    const fakeCli = join(root, "fake-cli.mjs");
    await writeFile(fakeCli, "process.stdout.write(process.argv[2])");
    process.env.PI_DEPO_CLI_PATH = fakeCli;
    const result = await packageStatus(root);
    expect(result.available).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("status");
  });
});
