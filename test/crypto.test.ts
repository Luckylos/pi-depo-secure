import { describe, expect, it } from "vitest";
import { decryptSnapshot, encryptSnapshot, normalizeSnapshotEntries } from "../src/crypto.js";

const entries = [
  { path: "models.json", mode: 0o600, sha256: "", contentBase64: Buffer.from("apiKey=secret").toString("base64") },
  { path: "agents/verifier.md", mode: 0o644, sha256: "", contentBase64: Buffer.from("safe instructions").toString("base64") },
];

describe("encrypted snapshot", () => {
  it("round-trips and does not expose plaintext", async () => {
    const envelope = await encryptSnapshot(entries, "correct horse battery staple");
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("secret");
    await expect(decryptSnapshot(envelope, "correct horse battery staple")).resolves.toEqual(normalizeSnapshotEntries(entries));
  });

  it("rejects a short passphrase", async () => {
    await expect(encryptSnapshot(entries, "too-short")).rejects.toThrow(/12/);
  });

  it("rejects the wrong passphrase and tampering", async () => {
    const envelope = await encryptSnapshot(entries, "correct horse battery staple");
    await expect(decryptSnapshot(envelope, "wrong passphrase here")).rejects.toThrow();
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.replace(/^./, envelope.ciphertext[0] === "A" ? "B" : "A") };
    await expect(decryptSnapshot(tampered, "correct horse battery staple")).rejects.toThrow();
  });

  it("rejects malformed and unsafe decrypted snapshots", async () => {
    await expect(encryptSnapshot([{ ...entries[0], path: "../escape" }], "correct horse battery staple")).rejects.toThrow(/path/i);
  });

  it("rejects unsupported KDF cost parameters", async () => {
    const envelope = await encryptSnapshot(entries, "correct horse battery staple");
    const altered = { ...envelope, kdf: { ...envelope.kdf, N: 65_536 } };
    await expect(decryptSnapshot(altered, "correct horse battery staple")).rejects.toThrow(/scrypt/i);
  });
});
