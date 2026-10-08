import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";

const AAD = Buffer.from("pi-gist-sync/v1", "utf8");
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export interface SnapshotEntry {
  path: string;
  mode: number;
  sha256: string;
  contentBase64: string;
}

export interface EncryptedSnapshot {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number; keyLength: number };
  iv: string;
  authTag: string;
  ciphertext: string;
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || Array.from(passphrase).length < 12) throw new Error("Passphrase must contain at least 12 characters");
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:[\/]/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function normalizeSnapshotEntries(entries: SnapshotEntry[]): SnapshotEntry[] {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const seen = new Set<string>();
  let total = 0;
  return sorted.map((entry) => {
    if (!isSafeRelativePath(entry.path)) throw new Error("Unsafe snapshot path: " + entry.path);
    if (seen.has(entry.path)) throw new Error("Duplicate snapshot path: " + entry.path);
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index++) if (seen.has(segments.slice(0, index).join("/"))) throw new Error("Snapshot path collides with a file: " + entry.path);
    seen.add(entry.path);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error("Invalid mode for " + entry.path);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256) && entry.sha256 !== "") throw new Error("Invalid hash for " + entry.path);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(entry.contentBase64) || (entry.contentBase64.length % 4 !== 0 && entry.contentBase64.length !== 0)) throw new Error("Invalid content encoding for " + entry.path);
    const content = Buffer.from(entry.contentBase64, "base64");
    if (content.length > MAX_ENTRY_BYTES) throw new Error("Snapshot entry exceeds size limit: " + entry.path);
    total += content.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Snapshot exceeds total size limit");
    const hash = sha256(content);
    if (entry.sha256 && entry.sha256 !== hash) throw new Error("Snapshot hash mismatch: " + entry.path);
    return { path: entry.path, mode: entry.mode, sha256: hash, contentBase64: content.toString("base64") };
  });
}

function deriveKey(passphrase: string, salt: Buffer, options: { N: number; r: number; p: number; keyLength: number; maxmem?: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, options.keyLength, { N: options.N, r: options.r, p: options.p, maxmem: options.maxmem ?? SCRYPT_OPTIONS.maxmem }, (error, derived) => {
      if (error) reject(error);
      else resolve(Buffer.from(derived));
    });
  });
}

export async function encryptSnapshot(entries: SnapshotEntry[], passphrase: string): Promise<EncryptedSnapshot> {
  validatePassphrase(passphrase);
  const normalized = normalizeSnapshotEntries(entries);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, { ...SCRYPT_OPTIONS, keyLength: KEY_LENGTH });
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 1, files: normalized }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    kdf: { name: "scrypt", salt: salt.toString("base64"), N: SCRYPT_OPTIONS.N, r: SCRYPT_OPTIONS.r, p: SCRYPT_OPTIONS.p, keyLength: KEY_LENGTH },
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function decryptSnapshot(envelope: EncryptedSnapshot, passphrase: string): Promise<SnapshotEntry[]> {
  validatePassphrase(passphrase);
  if (!envelope || envelope.schemaVersion !== 1 || envelope.algorithm !== "aes-256-gcm" || envelope.kdf?.name !== "scrypt") throw new Error("Unsupported encrypted snapshot");
  if (envelope.kdf.N !== SCRYPT_OPTIONS.N || envelope.kdf.r !== SCRYPT_OPTIONS.r || envelope.kdf.p !== SCRYPT_OPTIONS.p || envelope.kdf.keyLength !== KEY_LENGTH) throw new Error("Unsupported scrypt parameters");
  const salt = Buffer.from(envelope.kdf.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const authTag = Buffer.from(envelope.authTag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (salt.length !== 16 || iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) throw new Error("Malformed encrypted snapshot");
  const key = await deriveKey(passphrase, salt, envelope.kdf);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as { schemaVersion?: number; files?: SnapshotEntry[] };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) throw new Error("Invalid snapshot contents");
    return normalizeSnapshotEntries(parsed.files);
  } catch {
    throw new Error("Unable to decrypt snapshot");
  }
}

export const snapshotLimits = { maxEntryBytes: MAX_ENTRY_BYTES, maxTotalBytes: MAX_TOTAL_BYTES } as const;
