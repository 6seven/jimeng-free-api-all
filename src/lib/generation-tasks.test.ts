import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GenerationTasks, type GenerationRequest } from "./generation-tasks.ts";
import { generationTaskContext, reuseTaskUpload } from "./generation-task-context.ts";

const directories: string[] = [];
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-task-test-"));
  directories.push(root);
  return root;
}
afterEach(() => directories.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const input = (): GenerationRequest => ({ kind: "image", request: { prompt: "private-prompt", filePath: "private-media" } });
const result = { created: 1, data: [{ url: "https://example.com/original.png" }] };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("durable generation tasks", () => {
  it("coalesces repeated requests and preserves completed results without storing the request", async () => {
    const root = directory();
    const run = vi.fn(async (_request: GenerationRequest, _token: string) => result);
    const store = new GenerationTasks(root, run, vi.fn());
    const request = input();
    expect(store.submit("one", "private-token", request).status).toBe("queued");
    store.submit("one", "private-token", input());
    request.request.prompt = "mutated-prompt";
    await store.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].request.prompt).toBe("private-prompt");
    expect(store.get("one", "private-token").result).toEqual(result);
    store.submit("one", "private-token", input());
    const saved = fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), "utf8");
    for (const secret of ["private-token", "private-prompt", "private-media"]) expect(saved).not.toContain(secret);
    const restarted = new GenerationTasks(root, run, vi.fn());
    expect(restarted.get("one", "private-token").result).toEqual(result);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects changed requests and isolates account scopes", async () => {
    const run = vi.fn(async () => result);
    const store = new GenerationTasks(directory(), run, vi.fn());
    store.submit("same", "account-a", input());
    expect(() => store.submit("same", "account-a", { kind: "image", request: { prompt: "different" } })).toThrow("different request");
    expect(() => store.get("same", "account-b")).toThrow("not found");
    store.submit("same", "account-b", input());
    store.submit("new", "account-a", input());
    await store.idle();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("never resubmits an interrupted request without a provider ID", async () => {
    const root = directory();
    const run = vi.fn(async () => {
      generationTaskContext.getStore()!.beforeSubmit();
      return new Promise<typeof result>(() => {});
    });
    const original = new GenerationTasks(root, run, vi.fn());
    original.submit("uncertain", "account", input());
    await tick();
    const restarted = new GenerationTasks(root, run, vi.fn());
    expect(restarted.get("uncertain", "account").status).toBe("outcome_unknown");
    expect(restarted.submit("uncertain", "account", input()).status).toBe("outcome_unknown");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("recovers only the saved history ID after restart", async () => {
    const root = directory();
    const run = vi.fn(async () => {
      const context = generationTaskContext.getStore()!;
      context.beforeSubmit();
      context.submitted("history-exact");
      return new Promise<typeof result>(() => {});
    });
    const original = new GenerationTasks(root, run, vi.fn());
    original.submit("resume", "account", input());
    await tick();
    const recover = vi.fn(async () => result);
    const restarted = new GenerationTasks(root, run, recover);
    restarted.get("resume", "account");
    restarted.get("resume", "account");
    await restarted.idle();
    expect(recover).toHaveBeenCalledExactlyOnceWith("image", "history-exact", "account");
    expect(run).toHaveBeenCalledTimes(1);
    expect(restarted.get("resume", "account").result).toEqual(result);
  });

  it("keeps uncertain tasks beyond terminal retention and expires completed receipts", async () => {
    let now = 1;
    const root = directory();
    const run = vi.fn(async (request: GenerationRequest) => {
      if (request.request.prompt === "unknown") {
        generationTaskContext.getStore()!.beforeSubmit();
        throw new Error("private provider data");
      }
      return result;
    });
    const store = new GenerationTasks(root, run, vi.fn(), () => now, 100);
    store.submit("done", "account", input());
    store.submit("unknown", "account", { kind: "image", request: { prompt: "unknown" } });
    await store.idle();
    now = 102;
    expect(() => store.get("done", "account")).toThrow("expired");
    expect(store.get("unknown", "account").status).toBe("outcome_unknown");
    expect(JSON.stringify(store.get("unknown", "account"))).not.toContain("private provider data");
  });

  it("keeps a minimal tombstone after expiry so late retries cannot dispatch again", async () => {
    let now = 1;
    const root = directory();
    const run = vi.fn(async () => result);
    const store = new GenerationTasks(root, run, vi.fn(), () => now, 100);
    store.submit("late", "account", input());
    await store.idle();
    now = 102;
    const restarted = new GenerationTasks(root, run, vi.fn(), () => now, 100);
    expect(() => restarted.submit("late", "account", input())).toThrow("expired");
    expect(() => restarted.get("late", "account")).toThrow("expired");
    expect(() => restarted.submit("late", "account", { kind: "image", request: { prompt: "different" } })).toThrow("different request");
    expect(run).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), "utf8"));
    expect(Object.keys(saved).sort()).toEqual(["account", "expired", "fingerprint", "id"]);
    expect(saved.expired).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(result.data[0].url);
  });

  it("records explicit provider failure without another generation", async () => {
    const store = new GenerationTasks(directory(), async () => {
      const context = generationTaskContext.getStore()!;
      context.beforeSubmit();
      context.submitted("history-failed");
      context.providerFailed();
      throw new Error("failed");
    }, vi.fn());
    store.submit("failed", "account", input());
    await store.idle();
    expect(store.get("failed", "account").status).toBe("failed");
  });
});

describe("upload reuse", () => {
  it("reuses exact bytes within one task, persists successes immediately, and keeps tasks separate", async () => {
    const root = directory();
    const bytes = Buffer.from([0, 255, 17, 200, 0, 99]);
    const initial = Buffer.from(bytes);
    const upload = vi.fn(async () => ({ image_uri: "original-uri", uri: "original-uri" }));
    const run = async () => {
      const results = await Promise.all([
        reuseTaskUpload("account", bytes, upload),
        reuseTaskUpload("account", Buffer.from(bytes), upload),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(generationTaskContext.getStore()!.uploads).toHaveProperty(
        Object.keys(generationTaskContext.getStore()!.uploads)[0],
      );
      return result;
    };
    const store = new GenerationTasks(root, run, vi.fn());
    store.submit("first", "account", input());
    await store.idle();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(bytes.equals(initial)).toBe(true);
    expect(fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), "utf8")).toContain("original-uri");
    store.submit("second", "account", input());
    await store.idle();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed uploads or allow an account change", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error("failed upload"))
      .mockResolvedValue({ image_uri: "ok", uri: "ok" });
    const store = new GenerationTasks(directory(), async () => {
      const bytes = Buffer.from("unaltered");
      await expect(reuseTaskUpload("account", bytes, upload)).rejects.toThrow("failed upload");
      expect(generationTaskContext.getStore()!.uploads).toEqual({});
      await reuseTaskUpload("account", bytes, upload);
      await expect(reuseTaskUpload("another", bytes, upload)).rejects.toThrow("account mismatch");
      return result;
    }, vi.fn());
    store.submit("one", "account", input());
    await store.idle();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(store.get("one", "account").status).toBe("completed");
  });
});
