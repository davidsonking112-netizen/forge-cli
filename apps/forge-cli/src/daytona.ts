import { redactValue } from "./redaction.js";

const DEFAULT_API_URL = "https://app.daytona.io/api";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 100_000;

export interface DaytonaConfig {
  apiKey?: string;
  apiUrl?: string;
}

export interface DaytonaResult {
  ok: boolean;
  status: number | null;
  data?: unknown;
  error?: string;
}

export class DaytonaClient {
  private readonly apiKey: string | undefined;
  private readonly apiUrl: string;

  public constructor(config: DaytonaConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.DAYTONA_API_KEY;
    this.apiUrl = (
      config.apiUrl ??
      process.env.DAYTONA_API_URL ??
      DEFAULT_API_URL
    ).replace(/\/+$/, "");
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  public configuration(): { configured: boolean; apiUrl: string } {
    return { configured: this.isConfigured(), apiUrl: this.apiUrl };
  }

  public async getSandbox(
    id?: string,
    signal?: AbortSignal,
  ): Promise<DaytonaResult> {
    return this.request(
      id ? `/sandbox/${encodeURIComponent(validateSandboxId(id))}` : "/sandbox",
      {
        method: "GET",
      },
      signal,
    );
  }

  public async createSandbox(
    options: {
      snapshot?: string;
      image?: string;
      language?: "python" | "typescript" | "javascript";
      autoDeleteInterval?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<DaytonaResult> {
    if (!this.isConfigured()) return this.notConfigured();
    const body: Record<string, unknown> = {};
    if (options.snapshot)
      body.snapshot = validateSimpleValue(options.snapshot, "snapshot");
    if (options.image) body.image = validateSimpleValue(options.image, "image");
    if (options.language) body.language = options.language;
    if (options.autoDeleteInterval !== undefined) {
      if (
        !Number.isSafeInteger(options.autoDeleteInterval) ||
        options.autoDeleteInterval < -1 ||
        options.autoDeleteInterval > 43_200
      )
        throw new Error(
          "auto-delete interval must be an integer from -1 to 43200 minutes",
        );
      body.autoDeleteInterval = options.autoDeleteInterval;
    }
    return this.request(
      "/sandbox",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  public async stopSandbox(
    id: string,
    signal?: AbortSignal,
  ): Promise<DaytonaResult> {
    return this.request(
      `/sandbox/${encodeURIComponent(validateSandboxId(id))}/stop`,
      {
        method: "POST",
      },
      signal,
    );
  }

  public async deleteSandbox(
    id: string,
    signal?: AbortSignal,
  ): Promise<DaytonaResult> {
    return this.request(
      `/sandbox/${encodeURIComponent(validateSandboxId(id))}`,
      {
        method: "DELETE",
      },
      signal,
    );
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<DaytonaResult> {
    if (!this.isConfigured()) return this.notConfigured();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal?.aborted)
      return { ok: false, status: null, error: "Daytona request cancelled" };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.headers ?? {}),
        },
      });
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_RESPONSE_BYTES)
        return {
          ok: false,
          status: response.status,
          error: "Daytona response exceeded the 100000-byte limit",
        };
      const text = new TextDecoder().decode(bytes);
      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text.slice(0, MAX_RESPONSE_BYTES);
        }
      }
      if (!response.ok)
        return {
          ok: false,
          status: response.status,
          data: redactValue(data),
          error: `Daytona request failed with HTTP ${response.status}`,
        };
      return { ok: true, status: response.status, data: redactValue(data) };
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: signal?.aborted
          ? "Daytona request cancelled"
          : error instanceof Error
            ? error.message.slice(0, 500)
            : "Daytona request failed",
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private notConfigured(): DaytonaResult {
    return {
      ok: false,
      status: null,
      error:
        "Daytona is not configured; set DAYTONA_API_KEY without storing it in the repository.",
    };
  }
}

function validateSandboxId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
    throw new Error("Sandbox ID or name is invalid");
  return value;
}

function validateSimpleValue(value: string, label: string): string {
  if (!value || value.length > 500 || value.includes("\0"))
    throw new Error(`${label} is invalid or exceeds 500 characters`);
  return value;
}
