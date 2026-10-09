import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { GitHubTokenStore } from "./github-auth.js";

const KEY_FILE = "github-token.key";
const TOKEN_FILE = "github-token.enc";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface EncryptedToken {
  version: 1;
  algorithm: typeof ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface PortableGitHubTokenStoreOptions {
  directory?: string;
}

export function defaultGitHubCredentialDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "pi-depo-secure");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "pi-depo-secure");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-depo-secure");
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") await chmod(directory, 0o700);
}

async function readKey(directory: string): Promise<Buffer | undefined> {
  try {
    const key = await readFile(join(directory, KEY_FILE));
    if (key.length !== KEY_BYTES) throw new Error("GitHub credential store key has an invalid length");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof Error && error.message.includes("invalid length")) throw error;
    throw new Error("GitHub credential store key could not be read");
  }
}

async function createKey(directory: string): Promise<Buffer> {
  const existing = await readKey(directory);
  if (existing) return existing;
  const key = randomBytes(KEY_BYTES);
  try {
    await writeFile(join(directory, KEY_FILE), key, { flag: "wx", mode: 0o600 });
    if (platform() !== "win32") await chmod(join(directory, KEY_FILE), 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = await readKey(directory);
      if (raced) return raced;
    }
    throw new Error("GitHub credential store key could not be created");
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (platform() !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function encryptToken(key: Buffer, token: string): EncryptedToken {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString("base64").replace(/=+$/g, ""),
    tag: cipher.getAuthTag().toString("base64").replace(/=+$/g, ""),
    ciphertext: ciphertext.toString("base64").replace(/=+$/g, ""),
  };
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("invalid base64");
  return Buffer.from(value, "base64");
}

function decryptToken(key: Buffer, encrypted: EncryptedToken): string {
  if (encrypted.version !== 1 || encrypted.algorithm !== ALGORITHM) throw new Error("unsupported credential store format");
  const iv = decodeBase64(encrypted.iv);
  const tag = decodeBase64(encrypted.tag);
  const ciphertext = decodeBase64(encrypted.ciphertext);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("invalid credential store data");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function portableGitHubTokenStore(options: PortableGitHubTokenStoreOptions = {}): GitHubTokenStore {
  const directory = options.directory ?? defaultGitHubCredentialDirectory();
  const tokenPath = join(directory, TOKEN_FILE);

  return {
    async get(): Promise<string | undefined> {
      let raw: string;
      try {
        raw = await readFile(tokenPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("GitHub credential store could not be read");
      }
      const key = await readKey(directory);
      if (!key) throw new Error("GitHub credential store is incomplete");
      try {
        const encrypted = JSON.parse(raw) as EncryptedToken;
        const token = decryptToken(key, encrypted);
        if (!token.trim()) throw new Error("empty token");
        return token.trim();
      } catch {
        throw new Error("GitHub credential store is corrupt or unreadable");
      }
    },
    async set(token: string): Promise<void> {
      const value = token.trim();
      if (!value) throw new Error("Cannot store an empty GitHub token");
      await ensureDirectory(directory);
      const key = await createKey(directory);
      await writeAtomic(tokenPath, JSON.stringify(encryptToken(key, value)) + "\n");
    },
  };
}
