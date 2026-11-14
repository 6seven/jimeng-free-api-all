import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({
  default: { request: vi.fn(), get: vi.fn(), post: vi.fn(), head: vi.fn() },
}));
vi.mock("@/lib/logger.ts", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import axios from "axios";
import { readUploadSource, request, uploadFile } from "./core.ts";
import { GenerationTasks } from "../../lib/generation-tasks.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-media-test-"));
  vi.resetAllMocks();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const output = { created: 1, data: [{ url: "https://example.com/original.png" }] };
const input = { kind: "image" as const, request: { prompt: "secret-prompt" } };
const response = (data: unknown) => ({ status: 200, statusText: "OK", data: { ret: "0", data } });
const bytes = Buffer.from([0, 255, 10, 13, 80, 200, 99, 17]);
const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;

describe("reference transport", () => {
  it("keeps file and data URL bytes identical", async () => {
    const filename = path.join(root, "source.png");
    fs.writeFileSync(filename, bytes);
    expect((await readUploadSource(filename)).bytes.equals(bytes)).toBe(true);
    expect((await readUploadSource(dataUrl)).bytes.equals(bytes)).toBe(true);
    expect(axios.request).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("uploads original bytes once for duplicate frames, persisting the URI before generation", async () => {
    vi.mocked(axios.request).mockResolvedValue(response({
      access_key_id: "test-key", secret_access_key: "test-secret", session_token: "test-session",
    }));
    vi.mocked(axios.get).mockResolvedValue({ data: { Result: { UploadAddress: {
      UploadHosts: ["upload.example.com"], StoreInfos: [{ StoreUri: "test-uri", Auth: "test-auth" }],
      SessionKey: "test-session-key",
    } } } });
    vi.mocked(axios.post).mockImplementation(async (url, body) => {
      if (url.startsWith("https://upload.example.com/")) {
        expect(Buffer.isBuffer(body)).toBe(true);
        expect(Buffer.from(body as Buffer).equals(bytes)).toBe(true);
        return { data: { code: 2000 } };
      }
      return { data: { Result: { Results: [{ Uri: "original-provider-uri" }] } } };
    });
    const taskRoot = path.join(root, "tasks");
    const store = new GenerationTasks(taskRoot, async () => {
      const first = await uploadFile("account", dataUrl);
      const saved = JSON.parse(fs.readFileSync(path.join(taskRoot, fs.readdirSync(taskRoot)[0]), "utf8"));
      expect(Object.values(saved.uploads)).toEqual([first]);
      const second = await uploadFile("account", dataUrl);
      expect(second).toEqual(first);
      return output;
    }, vi.fn());
    store.submit("frames", "account", input);
    await store.idle();
    expect(store.get("frames", "account").status).toBe("completed");
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});

describe("provider submission checkpoints", () => {
  it("saves history_record_id before returning the provider response", async () => {
    vi.mocked(axios.request).mockResolvedValue(response({ aigc_data: { history_record_id: "history-123" } }));
    const store = new GenerationTasks(root, async () => {
      await request("post", "/mweb/v1/aigc_draft/generate", "account", { data: { prompt: "secret-prompt" } });
      const saved = JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), "utf8"));
      expect(saved.historyId).toBe("history-123");
      expect(saved.submissionStarted).toBe(true);
      expect(JSON.stringify(saved)).not.toContain("secret-prompt");
      return output;
    }, vi.fn());
    store.submit("history", "account", input);
    await store.idle();
    expect(store.get("history", "account").status).toBe("completed");
    expect(axios.request).toHaveBeenCalledTimes(1);
  });

  it("never retries an uncertain paid submission or submits again on task query", async () => {
    vi.mocked(axios.request).mockRejectedValue(Object.assign(new Error("network timeout"), { code: "ETIMEDOUT" }));
    const recover = vi.fn();
    const run = async () => {
      await request("post", "/mweb/v1/aigc_draft/generate", "account");
      return output;
    };
    const store = new GenerationTasks(root, run, recover);
    store.submit("timeout", "account", input);
    await store.idle();
    expect(store.get("timeout", "account").status).toBe("outcome_unknown");
    const restarted = new GenerationTasks(root, run, recover);
    restarted.get("timeout", "account");
    restarted.submit("timeout", "account", input);
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });
});
