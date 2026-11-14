import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./core.ts", () => ({ request: vi.fn(), uploadFile: vi.fn(), ensureCreditAvailable: vi.fn() }));
vi.mock("@/lib/logger.ts", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./models.ts", () => ({
  resolveImageModelConfig: vi.fn(async () => ({ modelReqKey: "test-image", defaultResolution: "2k", supportedResolutions: ["4k", "2k"] })),
  resolveVideoModelConfig: vi.fn(async () => ({ modelReqKey: "test-video", defaultResolution: "720p", supportedResolutions: ["1080p", "720p"], supportsLongDuration: true })),
}));

import { request, uploadFile } from "./core.ts";
import { generateImagesWithRetry, pollImageHistory } from "./images.ts";
import { generateVideoWithRetry, pollVideoHistory } from "./videos.ts";
import { generationTaskContext } from "../../lib/generation-task-context.ts";
import { GenerationTasks, type GenerationKind } from "../../lib/generation-tasks.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-history-test-"));
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
const output = (urls: string[]) => ({ created: 1, data: urls.map((url) => ({ url })) });

describe("history recovery", () => {
  it.each(["image", "video"] as GenerationKind[])("polls the saved %s history after interruption without another upload or generation", async (kind) => {
    const url = `https://example.com/original.${kind === "image" ? "png" : "mp4"}`;
    vi.mocked(request).mockResolvedValue({
      "saved-history": { status: 50, item_list: kind === "image"
        ? [{ image: { large_images: [{ image_url: url }] } }]
        : [{ video: { transcoded_video: { origin: { video_url: url } } } }] },
    });
    const run = vi.fn(async () => {
      const context = generationTaskContext.getStore()!;
      context.beforeSubmit();
      context.submitted("saved-history");
      throw new Error("poll interrupted");
    });
    const first = new GenerationTasks(root, run, vi.fn());
    first.submit("resume", "account", { kind, request: { prompt: "private" } });
    await first.idle();
    const restarted = new GenerationTasks(root, run, async (savedKind, id, token) =>
      output(savedKind === "image" ? await pollImageHistory(id, token) : [await pollVideoHistory(id, token)]));
    restarted.get("resume", "account");
    await vi.runAllTimersAsync();
    await restarted.idle();
    expect(restarted.get("resume", "account")).toMatchObject({ status: "completed", result: output([url]) });
    expect(run).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(request).mock.calls[0]).toMatchObject([
      "post", "/mweb/v1/get_history_by_ids", "account", { data: { history_ids: ["saved-history"] } },
    ]);
    if (kind === "image") expect(vi.mocked(request).mock.calls[0][3]?.data).not.toHaveProperty("image_info");
  });

  it("keeps the outcome unknown when only a thumbnail is available", async () => {
    vi.mocked(request).mockResolvedValue({ "history": { status: 50, item_list: [{ common_attr: { cover_url: "https://example.com/thumbnail.webp" } }] } });
    const store = new GenerationTasks(root, async () => {
      const context = generationTaskContext.getStore()!;
      context.beforeSubmit();
      context.submitted("history");
      return output(await pollImageHistory("history", "account"));
    }, vi.fn(async () => { throw new Error("no original"); }));
    store.submit("original", "account", { kind: "image", request: { prompt: "private" } });
    await vi.runAllTimersAsync();
    await store.idle();
    const receipt = store.get("original", "account");
    expect(receipt.status).toBe("outcome_unknown");
    expect(receipt.result).toBeUndefined();
    await store.idle();
  });

  it.each(["image", "video"] as GenerationKind[])("waits for completed %s results even when processing responses contain a preview", async (kind) => {
    const item = (url: string) => kind === "image"
      ? { image: { large_images: [{ image_url: url }] } }
      : { video: { transcoded_video: { origin: { video_url: url } } } };
    vi.mocked(request)
      .mockResolvedValueOnce({ history: { status: 42, item_list: [item("https://example.com/preview")] } })
      .mockResolvedValueOnce({ history: { status: 50, item_list: [item("https://example.com/original")] } });
    const store = new GenerationTasks(root, async () => {
      const context = generationTaskContext.getStore()!;
      context.beforeSubmit();
      context.submitted("history");
      return output(kind === "image" ? await pollImageHistory("history", "account") : [await pollVideoHistory("history", "account")]);
    }, vi.fn());
    store.submit("pending-preview", "account", { kind, request: { prompt: "private" } });
    await vi.runAllTimersAsync();
    await store.idle();
    expect(store.get("pending-preview", "account").result).toEqual(output(["https://example.com/original"]));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("matches the exact video history ID before selecting an origin URL", async () => {
    vi.mocked(request).mockResolvedValue({ history_records: [
      { history_record_id: "wrong", status: 50, item_list: [{ video: { transcoded_video: { origin: { video_url: "https://wrong.vod.example.com/preview" } } } }] },
      { history_record_id: "history", status: 50, item_list: [{ video: { transcoded_video: { origin: { video_url: "https://example.com/original.mp4" } } } }] },
    ] });
    const store = new GenerationTasks(root, async () => output([await pollVideoHistory("history", "account")]), vi.fn());
    store.submit("history-match", "account", { kind: "video", request: { prompt: "private" } });
    await vi.runAllTimersAsync();
    await store.idle();
    expect(store.get("history-match", "account").result).toEqual(output(["https://example.com/original.mp4"]));
  });

  it("rejects fallback video playback URLs instead of returning an unverified rendition", async () => {
    vi.mocked(request).mockResolvedValue({ history: { status: 50, item_list: [{ video: { play_url: "https://preview.vod.example.com/video.mp4" } }] } });
    const store = new GenerationTasks(root, async () => {
      const context = generationTaskContext.getStore()!;
      context.beforeSubmit();
      context.submitted("history");
      return output([await pollVideoHistory("history", "account")]);
    }, vi.fn(async () => { throw new Error("missing original"); }));
    store.submit("video-preview", "account", { kind: "video", request: { prompt: "private" } });
    await vi.runAllTimersAsync();
    await store.idle();
    expect(store.get("video-preview", "account")).toMatchObject({ status: "outcome_unknown" });
    await store.idle();
  });

  it("preserves the synchronous image endpoint's existing query and fallback behavior", async () => {
    vi.mocked(request).mockResolvedValue({ history: { status: 50, item_list: [{ common_attr: { cover_url: "https://example.com/cover.webp" } }] } });
    const pending = pollImageHistory("history", "account");
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(["https://example.com/cover.webp"]);
    expect(vi.mocked(request).mock.calls[0][3]?.data).toHaveProperty("image_info", expect.objectContaining({ width: 2048, height: 2048, format: "webp" }));
  });
});

describe("exact task generation", () => {
  it("preserves video duration, resolution and frame order in the submitted draft", async () => {
    vi.mocked(uploadFile).mockImplementation(async (_token, filename) => ({ image_uri: filename, uri: filename }));
    vi.mocked(request).mockImplementation(async (_method, uri, _token, options) => {
      if (uri === "/mweb/v1/aigc_draft/generate") {
        const draft = JSON.parse(options?.data.draft_content);
        const parameters = draft.component_list[0].abilities.gen_video.text_to_video_params;
        expect(parameters.video_aspect_ratio).toBe("9:16");
        expect(parameters.video_gen_inputs[0]).toMatchObject({
          duration_ms: 10000, resolution: "1080p",
          first_frame_image: { image_uri: "first.png" }, end_frame_image: { image_uri: "last.png" },
        });
        const context = generationTaskContext.getStore()!;
        context.beforeSubmit();
        context.submitted("history");
        return { aigc_data: { history_record_id: "history" } };
      }
      return { history: { status: 50, item_list: [{ video: { transcoded_video: { origin: { video_url: "https://example.com/original.mp4" } } } }] } };
    });
    const store = new GenerationTasks(root, async () => output([await generateVideoWithRetry(
      "video", "片中出现 5秒 的文字", { ratio: "9:16", resolution: "1080p", duration: 10,
        filePaths: ["first.png", "last.png"], fallbackPolicy: "exact" }, "account",
    )]), vi.fn());
    store.submit("video-parameters", "account", { kind: "video", request: { prompt: "private" } });
    await vi.runAllTimersAsync();
    await store.idle();
    expect(store.get("video-parameters", "account").status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not drop a failed end frame and continue to paid generation", async () => {
    vi.mocked(uploadFile).mockResolvedValueOnce({ image_uri: "first", uri: "first" }).mockRejectedValueOnce(new Error("end frame failed"));
    const store = new GenerationTasks(root, async () => output([await generateVideoWithRetry(
      "video", "private", { resolution: "1080p", duration: 10, filePaths: ["first.png", "end.png"], fallbackPolicy: "exact" }, "account",
    )]), vi.fn());
    store.submit("frames", "account", { kind: "video", request: { prompt: "private" } });
    await store.idle();
    expect(store.get("frames", "account").status).toBe("failed");
    expect(uploadFile).toHaveBeenNthCalledWith(1, "account", "first.png");
    expect(uploadFile).toHaveBeenNthCalledWith(2, "account", "end.png");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps an explicit image ratio and resolution when the prompt includes another ratio", async () => {
    vi.mocked(request).mockImplementation(async (_method, uri, _token, options) => {
      if (uri === "/mweb/v1/aigc_draft/generate") {
        const serialized = JSON.stringify(options?.data);
        expect(serialized).toContain("4096");
        const context = generationTaskContext.getStore()!;
        context.beforeSubmit();
        context.submitted("history");
        return { aigc_data: { history_record_id: "history" } };
      }
      return { history: { status: 50, item_list: [{ image: { large_images: [{ image_url: "https://example.com/original.png" }] } }] } };
    });
    const store = new GenerationTasks(root, async () => output(await generateImagesWithRetry(
      "jimeng-image-4.5", "A square with 16:9 text", { ratio: "1:1", resolution: "4k", fallbackPolicy: "exact" }, "account",
    )), vi.fn());
    store.submit("ratio", "account", { kind: "image", request: { prompt: "private" } });
    await vi.runAllTimersAsync();
    await store.idle();
    expect(store.get("ratio", "account").status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
