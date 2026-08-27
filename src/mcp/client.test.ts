import { AddressInfo } from "node:net";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeImageDataUrl, JimengApiClient } from "./client.ts";

interface CapturedRequest {
  method?: string;
  path?: string;
  authorization?: string;
  body?: any;
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("JimengApiClient", () => {
  const requests: CapturedRequest[] = [];
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    requests.length = 0;
    server = createServer(async (request, response) => {
      const rawBody = await readBody(request);
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      });

      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/token/points") {
        sendJson(response, [
          {
            token: "must-not-be-returned",
            points: { giftCredit: 3, purchaseCredit: 40, vipCredit: 2, totalCredit: 45 },
          },
        ]);
        return;
      }
      if (url.pathname === "/v1/models") {
        sendJson(response, { data: [{ id: "jimeng-image-test", supported_resolutions: ["1k"] }] });
        return;
      }
      if (url.pathname === "/v1/images/generations") {
        sendJson(response, { created: 123, data: [{ url: "https://example.com/image.png" }] });
        return;
      }
      if (url.pathname === "/v1/videos/generations") {
        sendJson(response, { created: 456, data: [{ url: "https://example.com/video.mp4" }] });
        return;
      }
      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("uses one sessionid and strips it from balance results", async () => {
    const client = new JimengApiClient({ baseUrl, sessionId: "paid-session" });
    await expect(client.getBalance()).resolves.toEqual({
      giftCredit: 3,
      purchaseCredit: 40,
      vipCredit: 2,
      totalCredit: 45,
    });
    expect(requests[0].authorization).toBe("Bearer paid-session");
    expect(JSON.stringify(await client.getBalance())).not.toContain("must-not-be-returned");
  });

  it("maps model and generation calls to the existing HTTP API", async () => {
    const client = new JimengApiClient({ baseUrl, sessionId: "paid-session" });
    await expect(client.listModels({ type: "image", refresh: true })).resolves.toHaveLength(1);
    await expect(
      client.generateImage({ model: "image-model", prompt: "image prompt" })
    ).resolves.toEqual({ created: 123, urls: ["https://example.com/image.png"] });
    await expect(
      client.generateVideo({
        model: "video-model",
        prompt: "video prompt",
        duration: 5,
        allowFallback: true,
      })
    ).resolves.toEqual({ created: 456, urls: ["https://example.com/video.mp4"] });

    const imageRequest = requests.find((request) => request.path === "/v1/images/generations");
    const videoRequest = requests.find((request) => request.path === "/v1/videos/generations");
    expect(imageRequest?.body.fallback_policy).toBe("exact");
    expect(imageRequest?.body.response_format).toBe("url");
    expect(videoRequest?.body.fallback_policy).toBe("auto");
    expect(videoRequest?.body.response_format).toBe("url");
  });

  it("rejects multiple accounts and unsafe image inputs", () => {
    expect(() => new JimengApiClient({ baseUrl, sessionId: "one,two" })).toThrow(
      "exactly one Jimeng sessionid"
    );
    expect(() => assertSafeImageDataUrl("/etc/passwd")).toThrow("base64 data URL");
    expect(() => assertSafeImageDataUrl("https://127.0.0.1/private.png")).toThrow(
      "base64 data URL"
    );
    expect(() => assertSafeImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toThrow(
      "PNG, JPEG, or WebP"
    );
    expect(() => assertSafeImageDataUrl("data:image/png;base64,!!!!")).toThrow("valid base64");
    expect(() => assertSafeImageDataUrl("data:image/png;base64,aGVsbG8=")).toThrow(
      "valid PNG"
    );
    expect(() =>
      assertSafeImageDataUrl(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      )
    ).not.toThrow();
    expect(() => assertSafeImageDataUrl("data:image/jpeg;base64,/9j/")).not.toThrow();
    expect(() =>
      assertSafeImageDataUrl("data:image/webp;base64,UklGRjAwMDBXRUJQ")
    ).not.toThrow();
  });
});
