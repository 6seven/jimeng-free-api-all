import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { request: vi.fn(), get: vi.fn(), post: vi.fn(), head: vi.fn() } }));
vi.mock("@/lib/logger.ts", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type Request from "../../lib/request/Request.ts";
import { GenerationTasks, type GenerationRequest } from "../../lib/generation-tasks.ts";
import { generationTaskRoutes, normalizeGenerationRequest } from "./generation-tasks.ts";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-routes-test-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const body = { kind: "image", request: { prompt: "private-prompt", resolution: "4k" } };
const output = { created: 1, data: [{ url: "https://example.com/original.png" }] };
const req = (changes: Partial<Request> = {}) => ({
  headers: { authorization: "Bearer account-a", "idempotency-key": "task-1" },
  params: { id: "task-1" }, body, ...changes,
}) as Request;

describe("generation task HTTP contract", () => {
  it("returns capabilities, 202 on submission, a stable result, 409 on changed input, and account-scoped 404", async () => {
    const run = vi.fn(async (_request: GenerationRequest, _token: string) => output);
    const store = new GenerationTasks(root, run, vi.fn());
    const routes = generationTaskRoutes(store);
    expect((await routes.get["/media-capabilities"]()).body).toEqual({ version: 1, generation_tasks: true });
    const submitted = await routes.post["/generation-tasks"](req());
    expect(submitted.statusCode).toBe(202);
    expect(submitted.body).toEqual({ id: "task-1", status: "queued" });
    await store.idle();
    const found = await routes.get["/generation-tasks/:id"](req());
    expect(found.statusCode).toBe(200);
    expect(found.body).toEqual({ id: "task-1", status: "completed", result: output });
    await routes.post["/generation-tasks"](req());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].request).toMatchObject({ resolution: "4k", fallback_policy: "exact", response_format: "url" });
    const changed = await routes.post["/generation-tasks"](req({ body: { ...body, request: { ...body.request, prompt: "different" } } }));
    expect(changed.statusCode).toBe(409);
    const otherAccount = await routes.get["/generation-tasks/:id"](req({ headers: { authorization: "Bearer account-b" } }));
    expect(otherAccount.statusCode).toBe(404);
  });

  it("rejects missing identity, changing accounts, automatic quality fallback, and inline media results before generation", async () => {
    const run = vi.fn(async () => output);
    const store = new GenerationTasks(root, run, vi.fn());
    const routes = generationTaskRoutes(store);
    expect((await routes.post["/generation-tasks"](req({ headers: {} }))).statusCode).toBe(401);
    expect((await routes.post["/generation-tasks"](req({ headers: { authorization: "Bearer account-a" } }))).statusCode).toBe(400);
    expect((await routes.post["/generation-tasks"](req({ headers: { authorization: "Bearer account-a,account-b", "idempotency-key": "task-1" } }))).statusCode).toBe(400);
    for (const field of [{ fallback_policy: "auto" }, { response_format: "b64_json" }, { ratio: "4:5" }, { file_paths: ["one"] }]) {
      expect((await routes.post["/generation-tasks"](req({ body: { ...body, request: { ...body.request, ...field } } }))).statusCode).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("does not accept a reference list that would discard frames", async () => {
    for (const request of [
      { prompt: "private", file_paths: ["first", "second", "third"] },
      { prompt: "private", file_paths: ["first", ""] },
      { prompt: "private", filePath: "wrong-field" },
    ]) {
      await expect(normalizeGenerationRequest({ kind: "video", request })).rejects.toThrow();
    }
  });
});

describe("reference request identity", () => {
  it("binds references to exact bytes, preserving frame order and duplicates", async () => {
    const first = Buffer.from([0, 255, 10, 13, 1]);
    const second = Buffer.from([0, 17, 19, 200, 2]);
    const firstPath = path.join(root, "first.png");
    const secondPath = path.join(root, "second.png");
    fs.writeFileSync(firstPath, first);
    fs.writeFileSync(secondPath, second);
    const normalize = (paths: string[]) => normalizeGenerationRequest({
      kind: "video", request: { prompt: "frames", file_paths: paths, resolution: "1080p", duration: 10 },
    });
    const frozen = await normalize([firstPath, secondPath]);
    const decode = (value: string) => Buffer.from(value.split(",")[1], "base64");
    const frames = frozen.request.file_paths as string[];
    expect(decode(frames[0]).equals(first)).toBe(true);
    expect(decode(frames[1]).equals(second)).toBe(true);
    const duplicates = await normalize([firstPath, firstPath]);
    expect(duplicates.request.file_paths).toEqual([frames[0], frames[0]]);
    expect(frozen.request).toMatchObject({ resolution: "1080p", duration: 10 });

    const run = vi.fn(async () => output);
    const store = new GenerationTasks(path.join(root, "tasks"), run, vi.fn());
    store.submit("references", "account", frozen);
    await store.idle();
    const reverse = await normalize([secondPath, firstPath]);
    expect(() => store.submit("references", "account", reverse)).toThrow("different request");
    fs.writeFileSync(firstPath, second);
    const modified = await normalize([firstPath, secondPath]);
    expect(() => store.submit("references", "account", modified)).toThrow("different request");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
