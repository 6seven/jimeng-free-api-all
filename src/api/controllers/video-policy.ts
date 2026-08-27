export type FallbackPolicy = "auto" | "exact";

export function getVideoDurationFallbacks(
  requestedDuration: number | undefined,
  fallbackPolicy: FallbackPolicy,
  supportsLongDuration: boolean
) {
  const duration = requestedDuration ?? (supportsLongDuration ? 10 : 5);

  if (duration !== 5 && duration !== 10) {
    throw new Error("视频时长仅支持 5 秒或 10 秒");
  }

  if (duration === 10 && !supportsLongDuration) {
    if (fallbackPolicy === "exact") {
      throw new Error("该模型不支持 10 秒视频");
    }
    return [5];
  }

  if (fallbackPolicy === "exact" || duration === 5) {
    return [duration];
  }

  return [10, 5];
}
