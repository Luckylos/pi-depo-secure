import { describe, expect, it } from "vitest";
import { promptConfirmedSecret, promptSecret } from "../src/secret-input.js";

type SecretComponent = { handleInput(data: string): void; render(width: number): string[] };

type FakeUi = {
  custom<T>(factory: (tui: { requestRender?: () => void }, theme: unknown, keybindings: unknown, done: (value: T) => void) => SecretComponent | Promise<SecretComponent>, options?: unknown): Promise<T>;
};

function fakeSecretUi(values: string[], renders: string[][]): FakeUi {
  return {
    async custom<T>(factory: (tui: { requestRender?: () => void }, theme: unknown, keybindings: unknown, done: (value: T) => void) => SecretComponent | Promise<SecretComponent>, _options: unknown) {
      let result: T | undefined;
      const component = await factory({}, {}, {}, (value: T) => { result = value; });
      renders.push(component.render(80));
      component.handleInput((values.shift() ?? "") + "\r");
      renders.push(component.render(80));
      return result as T;
    },
  };
}

describe("secret input", () => {
  it("never renders the passphrase in clear text", async () => {
    const renders: string[][] = [];
    const value = await promptSecret(fakeSecretUi(["correct horse battery staple"], renders), "Passphrase");

    expect(value).toBe("correct horse battery staple");
    expect(renders.flat().join("\n")).not.toContain("correct horse battery staple");
    expect(renders.flat().join("\n")).toContain("•");
  });

  it("asks twice and rejects a mismatched confirmation", async () => {
    const renders: string[][] = [];
    await expect(promptConfirmedSecret(fakeSecretUi(["correct horse battery staple", "different phrase"], renders), "Passphrase"))
      .rejects.toThrow(/do not match/i);
  });

  it("returns the confirmed passphrase", async () => {
    const renders: string[][] = [];
    await expect(promptConfirmedSecret(fakeSecretUi(["correct horse battery staple", "correct horse battery staple"], renders), "Passphrase"))
      .resolves.toBe("correct horse battery staple");
  });
});
