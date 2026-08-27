import { describe, expect, it } from "vitest";

import { getVideoDurationFallbacks } from "./video-policy.ts";

describe("video duration fallback policy", () => {
  it("rejects durations that cannot be executed exactly", () => {
    expect(() => getVideoDurationFallbacks(6, "exact", true)).toThrow(
      "视频时长仅支持 5 秒或 10 秒"
    );
    expect(() => getVideoDurationFallbacks(10, "exact", false)).toThrow(
      "不支持 10 秒视频"
    );
  });

  it("never increases a requested five-second duration during fallback", () => {
    expect(getVideoDurationFallbacks(5, "auto", true)).toEqual([5]);
  });

  it("falls back from ten seconds to five seconds when allowed", () => {
    expect(getVideoDurationFallbacks(10, "auto", true)).toEqual([10, 5]);
    expect(getVideoDurationFallbacks(10, "auto", false)).toEqual([5]);
  });
});
