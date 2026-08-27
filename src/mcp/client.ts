import axios, { AxiosError, AxiosInstance } from "axios";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

export interface JimengCreditBalance {
  giftCredit: number;
  purchaseCredit: number;
  vipCredit: number;
  totalCredit: number;
}

export interface JimengModel {
  id: string;
  object?: string;
  owned_by?: string;
  description?: string;
  name?: string;
  model_req_key?: string;
  supported_resolutions?: string[];
  default_resolution?: string;
  source?: string;
}

export interface GenerateImageInput {
  model: string;
  prompt: string;
  negativePrompt?: string;
  ratio?: string;
  resolution?: string;
  sampleStrength?: number;
  referenceImageDataUrl?: string;
  allowFallback?: boolean;
}

export interface GenerateVideoInput {
  model: string;
  prompt: string;
  ratio?: string;
  resolution?: string;
  duration?: 5 | 10;
  frameImageDataUrls?: string[];
  allowFallback?: boolean;
}

export interface GeneratedMedia {
  created?: number;
  urls: string[];
}

export interface JimengApiClientOptions {
  baseUrl: string;
  sessionId: string;
  timeoutMs?: number;
}

function normalizeBaseUrl(baseUrl: string) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("JIMENG_API_BASE_URL must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeCreditBalance(value: any): JimengCreditBalance {
  const keys = ["giftCredit", "purchaseCredit", "vipCredit", "totalCredit"] as const;
  const result = {} as JimengCreditBalance;
  for (const key of keys) {
    const numberValue = Number(value?.[key]);
    if (!Number.isFinite(numberValue)) {
      throw new Error(`Jimeng API returned an invalid balance field: ${key}`);
    }
    result[key] = numberValue;
  }
  return result;
}

function getImageDataSize(payload: string) {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function isMatchingImageSignature(format: string, data: Buffer) {
  if (format === "png") {
    return data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (format === "jpg" || format === "jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  return (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  );
}

export function assertSafeImageDataUrl(value: string) {
  const match = IMAGE_DATA_URL_PATTERN.exec(value);
  if (!match) {
    if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(value)) {
      throw new Error("Image input must contain valid base64 data");
    }
    throw new Error("Image input must be a PNG, JPEG, or WebP base64 data URL");
  }
  const [, format, payload] = match;
  if (payload.length % 4 !== 0) {
    throw new Error("Image input must contain valid base64 data");
  }
  if (getImageDataSize(payload) > MAX_IMAGE_BYTES) {
    throw new Error("Image input exceeds the MCP limit of 20 MiB");
  }
  const data = Buffer.from(payload, "base64");
  if (!isMatchingImageSignature(format.toLowerCase(), data)) {
    throw new Error(`Image input must contain valid ${format.toUpperCase()} data`);
  }
}

function getResponseErrorMessage(error: AxiosError<any>) {
  const data = error.response?.data;
  const message = data?.error?.message || data?.message || data?.errmsg;
  if (typeof message === "string" && message.trim()) return message.trim().slice(0, 500);
  if (typeof data === "string" && data.trim()) return data.trim().slice(0, 500);
  return error.message;
}

export class JimengApiClient {
  private readonly http: AxiosInstance;

  constructor(options: JimengApiClientOptions) {
    const sessionId = options.sessionId.trim();
    if (!sessionId || sessionId.includes(",")) {
      throw new Error("JIMENG_SESSION_ID must contain exactly one Jimeng sessionid");
    }

    this.http = axios.create({
      baseURL: normalizeBaseUrl(options.baseUrl),
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${sessionId}`,
        "Content-Type": "application/json",
      },
      maxBodyLength: 30 * 1024 * 1024,
      maxContentLength: 30 * 1024 * 1024,
    });
  }

  private async request<T>(request: () => Promise<{ data: T }>) {
    try {
      return (await request()).data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const prefix = status ? `Jimeng API request failed (${status})` : "Jimeng API request failed";
        throw new Error(`${prefix}: ${getResponseErrorMessage(error)}`);
      }
      throw error;
    }
  }

  async getBalance() {
    const rows = await this.request<any[]>(() => this.http.post("/token/points", {}));
    const points = Array.isArray(rows) ? rows[0]?.points : undefined;
    if (!points) throw new Error("Jimeng API returned no account balance");
    return normalizeCreditBalance(points);
  }

  async listModels(options: { type?: "image" | "video"; refresh?: boolean } = {}) {
    const response = await this.request<{ data?: JimengModel[] }>(() =>
      this.http.get("/v1/models", {
        params: {
          ...(options.type ? { type: options.type } : {}),
          ...(options.refresh ? { refresh: "true" } : {}),
        },
      })
    );
    if (!Array.isArray(response?.data)) throw new Error("Jimeng API returned an invalid model list");
    return response.data;
  }

  async generateImage(input: GenerateImageInput): Promise<GeneratedMedia> {
    if (input.referenceImageDataUrl) assertSafeImageDataUrl(input.referenceImageDataUrl);
    const response = await this.request<any>(() =>
      this.http.post("/v1/images/generations", {
        model: input.model,
        prompt: input.prompt,
        negative_prompt: input.negativePrompt,
        ratio: input.ratio,
        resolution: input.resolution,
        sample_strength: input.sampleStrength,
        filePath: input.referenceImageDataUrl,
        response_format: "url",
        fallback_policy: input.allowFallback ? "auto" : "exact",
      })
    );
    const urls = Array.isArray(response?.data)
      ? response.data.map((item: any) => item?.url).filter((url: any) => typeof url === "string" && url)
      : [];
    if (urls.length === 0) throw new Error("Jimeng API returned no image URL");
    return { created: response.created, urls };
  }

  async generateVideo(input: GenerateVideoInput): Promise<GeneratedMedia> {
    const frameImageDataUrls = input.frameImageDataUrls || [];
    if (frameImageDataUrls.length > 2) throw new Error("Video generation accepts at most two frame images");
    frameImageDataUrls.forEach(assertSafeImageDataUrl);
    const response = await this.request<any>(() =>
      this.http.post("/v1/videos/generations", {
        model: input.model,
        prompt: input.prompt,
        ratio: input.ratio,
        resolution: input.resolution,
        duration: input.duration,
        file_paths: frameImageDataUrls,
        response_format: "url",
        fallback_policy: input.allowFallback ? "auto" : "exact",
      })
    );
    const urls = Array.isArray(response?.data)
      ? response.data.map((item: any) => item?.url).filter((url: any) => typeof url === "string" && url)
      : [];
    if (urls.length === 0) throw new Error("Jimeng API returned no video URL");
    return { created: response.created, urls };
  }
}

function parseTimeout(value?: string) {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000) {
    throw new Error("JIMENG_MCP_REQUEST_TIMEOUT_MS must be an integer of at least 1000");
  }
  return timeout;
}

export function createJimengApiClientFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return new JimengApiClient({
    baseUrl: env.JIMENG_API_BASE_URL || DEFAULT_BASE_URL,
    sessionId: env.JIMENG_SESSION_ID || "",
    timeoutMs: parseTimeout(env.JIMENG_MCP_REQUEST_TIMEOUT_MS),
  });
}
