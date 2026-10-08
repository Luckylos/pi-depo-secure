import { describe, expect, it } from "vitest";
import { GistClient, mergeOwnedGistFiles } from "../src/gist-remote.js";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub Gist client", () => {
  it("sends bearer auth and manages only owned files", async () => {
    const calls: Request[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return response(200, { id: "gist-1", files: { "unrelated.txt": { filename: "unrelated.txt", content: "keep" } } });
    };
    const client = new GistClient("token-value", fetcher);
    await client.update("gist-1", { "pi-gist-sync.manifest.json": "{}" });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("authorization")).toBe("Bearer token-value");
    const body = await calls[0].json() as { files: Record<string, { content: string }> };
    expect(body.files["pi-gist-sync.manifest.json"].content).toBe("{}");
    expect(JSON.stringify(body)).not.toContain("token-value");
  });

  it("preserves files not owned by the fork", () => {
    const result = mergeOwnedGistFiles(
      { "pi-depo.yml": "packages: {}", "pi-depo.lock.json": "{}", "other.txt": "keep" },
      { "pi-gist-sync.manifest.json": "{}", "pi-gist-sync.config.enc.json": "{}" },
    );
    expect(result).toEqual({
      "pi-depo.yml": "packages: {}",
      "pi-depo.lock.json": "{}",
      "other.txt": "keep",
      "pi-gist-sync.manifest.json": "{}",
      "pi-gist-sync.config.enc.json": "{}",
    });
  });

  it("redacts response bodies from API errors", async () => {
    const fetcher = async () => response(401, { message: "token-value should not leak" });
    const client = new GistClient("token-value", fetcher);
    await expect(client.get("gist-1")).rejects.toThrow(/401/);
    await expect(client.get("gist-1")).rejects.not.toThrow(/token-value/);
  });
});
