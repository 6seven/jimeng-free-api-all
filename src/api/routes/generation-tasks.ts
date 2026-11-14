import path from "node:path";
import mime from "mime";

import type Request from "../../lib/request/Request.ts";
import Response from "../../lib/response/Response.ts";
import { GenerationTaskError, GenerationTasks, type GenerationRequest } from "../../lib/generation-tasks.ts";
import { readUploadSource, tokenSplit } from "../controllers/core.ts";
import { DEFAULT_MODEL as IMAGE_MODEL, generateImagesWithRetry, pollImageHistory } from "../controllers/images.ts";
import { DEFAULT_MODEL as VIDEO_MODEL, generateVideoWithRetry, pollVideoHistory } from "../controllers/videos.ts";

function result(urls: string[]) {
  return { created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) };
}

export const generationTasks = new GenerationTasks(
  process.env.JIMENG_GENERATION_TASKS_DIR || path.join(process.cwd(), "data", "generation-tasks"),
  async ({ kind, request }, token) => {
    const options = {
      ratio: request.ratio as string | undefined,
      resolution: request.resolution as string | undefined,
      fallbackPolicy: "exact" as const,
    };
    if (kind === "image") {
      return result(await generateImagesWithRetry(
        request.model as string || IMAGE_MODEL, request.prompt as string,
        {
          ...options,
          negativePrompt: request.negative_prompt as string | undefined,
          sampleStrength: request.sample_strength as number | undefined,
          filePath: request.filePath as string | undefined,
        }, token,
      ));
    }
    return result([await generateVideoWithRetry(
      request.model as string || VIDEO_MODEL, request.prompt as string,
      {
        ...options,
        duration: request.duration as number | undefined,
        filePaths: request.file_paths as string[] | undefined,
      }, token,
    )]);
  },
  async (kind, historyId, token) => result(kind === "image"
    ? await pollImageHistory(historyId, token)
    : [await pollVideoHistory(historyId, token)]),
);

function token(request: Request): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") throw new GenerationTaskError(401, "Authorization required");
  const tokens = tokenSplit(authorization);
  if (tokens.length !== 1) throw new GenerationTaskError(400, "Exactly one account token is required");
  return tokens[0];
}

async function reference(source: string): Promise<string> {
  const { bytes, filename } = await readUploadSource(source);
  const contentType = /^data:([^;,]+)/.exec(source)?.[1] || mime.getType(filename) || "image/png";
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

export async function normalizeGenerationRequest(body: unknown): Promise<GenerationRequest> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GenerationTaskError(400, "Invalid generation task");
  }
  const { kind, request } = body as GenerationRequest;
  if (!["image", "video"].includes(kind) || !request || typeof request !== "object" || Array.isArray(request)) {
    throw new GenerationTaskError(400, "A generation kind and request are required");
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    throw new GenerationTaskError(400, "A nonempty prompt is required");
  }
  for (const key of ["model", "ratio", "resolution", "negative_prompt", "filePath"]) {
    if (request[key] !== undefined && typeof request[key] !== "string") {
      throw new GenerationTaskError(400, `Invalid ${key}`);
    }
  }
  const ratios = kind === "image" ? ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]
    : ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
  if (request.ratio !== undefined && !ratios.includes(request.ratio as string)) {
    throw new GenerationTaskError(400, "Invalid ratio");
  }
  if (request.fallback_policy !== undefined && request.fallback_policy !== "exact") {
    throw new GenerationTaskError(400, "Task generation requires fallback_policy=exact");
  }
  if (request.response_format !== undefined && request.response_format !== "url") {
    throw new GenerationTaskError(400, "Task results use response_format=url");
  }
  if (request.sample_strength !== undefined && (typeof request.sample_strength !== "number" || !Number.isFinite(request.sample_strength))) {
    throw new GenerationTaskError(400, "Invalid sample_strength");
  }
  if (request.duration !== undefined && ![5, 10].includes(request.duration as number)) {
    throw new GenerationTaskError(400, "Video duration must be 5 or 10 seconds");
  }
  if (request.filePath !== undefined && !request.filePath) throw new GenerationTaskError(400, "Invalid filePath");
  if ((kind === "image" && request.file_paths !== undefined) || (kind === "video" && request.filePath !== undefined)) {
    throw new GenerationTaskError(400, "Use filePath for image tasks or file_paths for video tasks");
  }
  if (request.file_paths !== undefined && (!Array.isArray(request.file_paths) || request.file_paths.length > 2 ||
    request.file_paths.some((value) => typeof value !== "string" || !value))) {
    throw new GenerationTaskError(400, "Invalid file_paths");
  }
  const frozen = structuredClone(request);
  frozen.fallback_policy = "exact";
  frozen.response_format = "url";
  const references = new Map<string, Promise<string>>();
  const freezeReference = (source: string) => {
    if (!references.has(source)) references.set(source, reference(source));
    return references.get(source)!;
  };
  if (frozen.filePath) frozen.filePath = await freezeReference(frozen.filePath as string);
  if (frozen.file_paths) frozen.file_paths = await Promise.all((frozen.file_paths as string[]).map(freezeReference));
  return { kind, request: frozen };
}

async function respond(operation: () => unknown | Promise<unknown>, statusCode = 200): Promise<Response> {
  try {
    return new Response(await operation(), { statusCode });
  } catch (error) {
    if (error instanceof GenerationTaskError) {
      return new Response({ error: error.message }, { statusCode: error.statusCode });
    }
    return new Response({ error: "Generation task request could not be processed" }, { statusCode: 500 });
  }
}

export function generationTaskRoutes(tasks = generationTasks) {
  return {
    prefix: "/v1",
    get: {
      "/media-capabilities": async () => new Response({ version: 1, generation_tasks: true }),
      "/generation-tasks/:id": async (request: Request) => respond(() => tasks.get(request.params.id, token(request))),
    },
    post: {
      "/generation-tasks": async (request: Request) => respond(async () => {
        const account = token(request);
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new GenerationTaskError(400, "Idempotency-Key required");
        return tasks.submit(key, account, await normalizeGenerationRequest(request.body));
      }, 202),
    },
  };
}

export default generationTaskRoutes();
