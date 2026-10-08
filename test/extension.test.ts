import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../extensions/pi-depo-sync.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.PI_GIST_SYNC_PASSPHRASE;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_DEPO_CLI_PATH;
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("pi-gist-sync extension", () => {
  it("registers one gist-sync namespace and refuses headless writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gist-sync-extension-"));
    roots.push(root);
    await writeFile(join(root, "settings.json"), "local");
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PI_GIST_SYNC_PASSPHRASE = "correct horse battery staple";
    let command: { handler(args: string, ctx: any): Promise<void> } | undefined;
    const notifications: string[] = [];
    register({ registerCommand(name, options) { expect(name).toBe("gist-sync"); command = options; } });
    expect(command).toBeDefined();
    await command!.handler("push", { hasUI: false, ui: { input: async () => undefined, confirm: async () => true, notify: (message: string) => notifications.push(message) } });
    expect(notifications.join("\n")).toMatch(/confirmation|interactive/i);

    const fakeCli = join(root, "pd.mjs");
    await writeFile(fakeCli, "process.stdout.write(process.argv[2])");
    process.env.PI_DEPO_CLI_PATH = fakeCli;
    await command!.handler("packages status", { hasUI: true, ui: { input: async () => undefined, confirm: async () => true, notify: (message: string) => notifications.push(message) } });
    expect(notifications).toContain("status");
    await command!.handler("push --packages", { hasUI: true, ui: { input: async () => undefined, confirm: async () => true, notify: (message: string) => notifications.push(message) } });
    expect(notifications.at(-1)).toMatch(/packages.*separate|use.*packages/i);
  });
});
