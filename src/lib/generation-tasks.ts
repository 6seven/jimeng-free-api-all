import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  accountFingerprint,
  generationTaskContext,
  type GenerationTaskContext,
  type UploadedFile,
} from "./generation-task-context.ts";

export type GenerationKind = "image" | "video";
export type GenerationResult = { created: number; data: { url: string }[] };
export type GenerationStatus = "queued" | "running" | "completed" | "failed" | "outcome_unknown";
export type GenerationRequest = { kind: GenerationKind; request: Record<string, unknown> };
export type GenerationTaskView = {
  id: string;
  status: GenerationStatus;
  result?: GenerationResult;
  error?: string;
};

type Receipt = GenerationTaskView & {
  account: string;
  fingerprint: string;
  kind: GenerationKind;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  submissionStarted?: boolean;
  historyId?: string;
  knownFailure?: boolean;
  uploads: Record<string, UploadedFile>;
};
type ExpiredReceipt = Pick<Receipt, "id" | "account" | "fingerprint"> & { expired: true };
type StoredReceipt = Receipt | ExpiredReceipt;

function isExpiredReceipt(receipt: StoredReceipt): receipt is ExpiredReceipt {
  return "expired" in receipt && receipt.expired === true;
}

type Runner = (request: GenerationRequest, token: string) => Promise<GenerationResult>;
type Recovery = (kind: GenerationKind, historyId: string, token: string) => Promise<GenerationResult>;

export class GenerationTaskError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class GenerationTasks {
  private active = new Map<string, Promise<void>>();
  private ttl: number;
  private lastSweep = -Infinity;

  constructor(
    private root: string,
    private run: Runner,
    private recover: Recovery,
    private now: () => number = Date.now,
    ttl = 24 * 60 * 60 * 1000,
  ) {
    this.ttl = ttl;
  }

  private location(account: string, id: string): string {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) {
      throw new GenerationTaskError(400, "Invalid Idempotency-Key");
    }
    const key = createHash("sha256").update(`${account}\0${id}`).digest("hex");
    return path.join(this.root, `${key}.json`);
  }

  private write(filename: string, receipt: StoredReceipt, exclusive = false): boolean {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(receipt));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (exclusive) {
        try {
          fs.linkSync(temporary, filename);
        } catch (error) {
          if (error.code === "EEXIST") return false;
          throw error;
        }
      } else {
        fs.renameSync(temporary, filename);
      }
      const directory = fs.openSync(this.root, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return true;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private expired(receipt: StoredReceipt): boolean {
    return !isExpiredReceipt(receipt) && ["completed", "failed"].includes(receipt.status) &&
      Number.isFinite(receipt.finishedAt) && this.now() - receipt.finishedAt! >= this.ttl;
  }

  private expire(filename: string, receipt: StoredReceipt): ExpiredReceipt {
    const expired: ExpiredReceipt = { id: receipt.id, account: receipt.account, fingerprint: receipt.fingerprint, expired: true };
    this.write(filename, expired);
    return expired;
  }

  private sweep(): void {
    if (this.now() - this.lastSweep < Math.min(this.ttl, 60_000)) return;
    this.lastSweep = this.now();
    if (!fs.existsSync(this.root)) return;
    for (const entry of fs.readdirSync(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      const filename = path.join(this.root, entry);
      if (this.active.has(filename)) continue;
      try {
        const receipt = JSON.parse(fs.readFileSync(filename, "utf8"));
        if (this.expired(receipt)) this.expire(filename, receipt);
      } catch {
        // Unreadable receipts remain as evidence against another paid submission.
      }
    }
  }

  private read(filename: string): StoredReceipt | undefined {
    if (!fs.existsSync(filename)) return undefined;
    let receipt: StoredReceipt;
    try {
      receipt = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (!/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !/^[a-f0-9]{64}$/.test(receipt.account) ||
        typeof receipt.id !== "string" || this.location(receipt.account, receipt.id) !== filename) {
        throw new Error("Invalid receipt");
      }
      if (isExpiredReceipt(receipt)) return receipt;
      if (!receipt.uploads ||
        !["image", "video"].includes(receipt.kind) ||
        !["queued", "running", "completed", "failed", "outcome_unknown"].includes(receipt.status) ||
        (receipt.status === "completed" && !receipt.result?.data?.length)) {
        throw new Error("Invalid receipt");
      }
    } catch {
      throw new GenerationTaskError(409, "Task state unavailable; do not resubmit generation");
    }
    if (this.expired(receipt)) {
      return this.expire(filename, receipt);
    }
    if (!this.active.has(filename) && ["queued", "running"].includes(receipt.status)) {
      receipt.status = "outcome_unknown";
      receipt.error = "Generation interrupted; query the same task to recover";
      this.write(filename, receipt);
    }
    return receipt;
  }

  private view(receipt: Receipt): GenerationTaskView {
    return {
      id: receipt.id,
      status: receipt.status,
      ...(receipt.result ? { result: structuredClone(receipt.result) } : {}),
      ...(receipt.error ? { error: receipt.error } : {}),
    };
  }

  submit(id: string, token: string, request: GenerationRequest): GenerationTaskView {
    this.sweep();
    const frozen = structuredClone(request);
    const account = accountFingerprint(token);
    const filename = this.location(account, id);
    const fingerprint = createHash("sha256").update(canonical(frozen)).digest("hex");
    const previous = this.read(filename);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new GenerationTaskError(409, "Idempotency-Key is bound to a different request");
      }
      if (isExpiredReceipt(previous)) throw new GenerationTaskError(410, "Task result expired; do not resubmit generation");
      return this.resume(filename, previous, token);
    }
    const receipt: Receipt = {
      id, account, fingerprint, kind: frozen.kind, status: "queued",
      createdAt: this.now(), updatedAt: this.now(), uploads: {},
    };
    if (!this.write(filename, receipt, true)) return this.submit(id, token, frozen);
    this.launch(filename, receipt, () => this.run(frozen, token));
    return this.view(receipt);
  }

  get(id: string, token: string): GenerationTaskView {
    this.sweep();
    const filename = this.location(accountFingerprint(token), id);
    const receipt = this.read(filename);
    if (!receipt) throw new GenerationTaskError(404, "Task not found; do not resubmit generation");
    if (isExpiredReceipt(receipt)) throw new GenerationTaskError(410, "Task result expired; do not resubmit generation");
    return this.resume(filename, receipt, token);
  }

  private resume(filename: string, receipt: Receipt, token: string): GenerationTaskView {
    if (!this.active.has(filename) && receipt.status === "outcome_unknown" && receipt.historyId) {
      this.launch(filename, receipt, () => this.recover(receipt.kind, receipt.historyId!, token));
    }
    return this.view(receipt);
  }

  private launch(filename: string, receipt: Receipt, operation: () => Promise<GenerationResult>): void {
    const save = () => {
      receipt.updatedAt = this.now();
      this.write(filename, receipt);
    };
    const context: GenerationTaskContext = {
      account: receipt.account,
      uploads: receipt.uploads,
      uploading: new Map(),
      save,
      beforeSubmit: () => {
        if (receipt.submissionStarted) throw new Error("Generation was already submitted");
        receipt.submissionStarted = true;
        save();
      },
      submitted: (historyId) => {
        if (typeof historyId !== "string" || !historyId) throw new Error("Missing history ID");
        receipt.historyId = historyId;
        save();
      },
      providerFailed: () => { receipt.knownFailure = true; save(); },
    };
    const pending = Promise.resolve().then(async () => {
      receipt.status = "running";
      delete receipt.error;
      save();
      try {
        const result = await generationTaskContext.run(context, operation);
        if (!result?.data?.length || result.data.some((entry) => !/^https?:\/\//.test(entry.url))) {
          throw new Error("Generation returned no usable outputs");
        }
        receipt.result = result;
        receipt.status = "completed";
        receipt.finishedAt = this.now();
      } catch {
        receipt.status = receipt.knownFailure || !receipt.submissionStarted ? "failed" : "outcome_unknown";
        receipt.error = receipt.status === "failed"
          ? "Generation failed; no automatic resubmission"
          : "Generation outcome unavailable; query the same task";
        if (receipt.status === "failed") receipt.finishedAt = this.now();
      }
      save();
    }).catch(() => {
      // A durable pre-submit marker prevents a restart from repeating an uncertain request.
    }).finally(() => this.active.delete(filename));
    this.active.set(filename, pending);
  }

  async idle(): Promise<void> {
    await Promise.all(this.active.values());
  }
}
