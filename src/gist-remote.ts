export interface GistFile { filename?: string; content?: string; truncated?: boolean }
export interface GistResponse { id: string; description?: string; public?: boolean; files?: Record<string, GistFile> }
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const SYNC_MANIFEST_FILE = "pi-gist-sync.manifest.json";
export const SYNC_CONFIG_FILE = "pi-gist-sync.config.enc.json";

function filesPayload(files: Record<string, string>): Record<string, { content: string }> {
  return Object.fromEntries(Object.entries(files).map(([filename, content]) => [filename, { content }]));
}

export function mergeOwnedGistFiles(existing: Record<string, string>, owned: Record<string, string>): Record<string, string> {
  return { ...existing, ...owned };
}

export class GistClient {
  private readonly fetcher: Fetcher;
  constructor(private readonly token: string, fetcher: Fetcher = fetch, private readonly baseUrl = "https://api.github.com") {
    if (!token.trim()) throw new Error("GitHub token is required");
    this.fetcher = fetcher;
  }

  private async request(path: string, init: RequestInit = {}): Promise<GistResponse | GistResponse[]> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    headers.set("authorization", "Bearer " + this.token);
    headers.set("x-github-api-version", "2022-11-28");
    headers.set("user-agent", "pi-depo-fork/0.2.0");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try { response = await this.fetcher(this.baseUrl + path, { ...init, headers }); }
    catch { throw new Error("GitHub Gist request failed"); }
    if (!response.ok) throw new Error("GitHub Gist request failed with status " + response.status);
    return response.json() as Promise<GistResponse | GistResponse[]>;
  }

  async get(id: string): Promise<GistResponse> { return this.request("/gists/" + encodeURIComponent(id)) as Promise<GistResponse>; }
  async list(): Promise<GistResponse[]> { return this.request("/gists?per_page=100") as Promise<GistResponse[]>; }
  async create(description: string, isPublic: boolean, files: Record<string, string>): Promise<GistResponse> {
    return this.request("/gists", { method: "POST", body: JSON.stringify({ description, public: isPublic, files: filesPayload(files) }) }) as Promise<GistResponse>;
  }
  async update(id: string, files: Record<string, string>): Promise<GistResponse> {
    return this.request("/gists/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ files: filesPayload(files) }) }) as Promise<GistResponse>;
  }
}
