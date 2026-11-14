import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type UploadedFile = { image_uri: string; uri: string };

export interface GenerationTaskContext {
  account: string;
  uploads: Record<string, UploadedFile>;
  uploading: Map<string, Promise<UploadedFile>>;
  save(): void;
  beforeSubmit(): void;
  submitted(historyId: string): void;
  providerFailed(): void;
}

export const generationTaskContext = new AsyncLocalStorage<GenerationTaskContext>();

export function accountFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function reuseTaskUpload(
  token: string,
  bytes: Buffer,
  upload: () => Promise<UploadedFile>,
): Promise<UploadedFile> {
  const context = generationTaskContext.getStore();
  if (!context) return upload();
  if (context.account !== accountFingerprint(token)) {
    throw new Error("Generation upload account mismatch");
  }
  const key = createHash("sha256").update(bytes).digest("hex");
  if (context.uploads[key]) return context.uploads[key];
  if (context.uploading.has(key)) return context.uploading.get(key)!;
  const pending = Promise.resolve().then(upload).then((result) => {
    if (!result.image_uri || !result.uri) throw new Error("Upload returned no resource URI");
    context.uploads[key] = result;
    context.save();
    return result;
  });
  context.uploading.set(key, pending);
  try {
    return await pending;
  } finally {
    context.uploading.delete(key);
  }
}
