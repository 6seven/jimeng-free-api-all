import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createJimengMcpServer } from "./server.ts";

const balanceBefore = {
  giftCredit: 0,
  purchaseCredit: 100,
  vipCredit: 0,
  totalCredit: 100,
};

const balanceAfter = {
  giftCredit: 0,
  purchaseCredit: 94,
  vipCredit: 0,
  totalCredit: 94,
};

describe("Jimeng MCP server", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  async function connect(fakeClient: any) {
    const server = createJimengMcpServer(fakeClient);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it("exposes the four paid-account tools", async () => {
    const client = await connect({
      getBalance: vi.fn(),
      listModels: vi.fn(),
      generateImage: vi.fn(),
      generateVideo: vi.fn(),
    });
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "jimeng_get_balance",
      "jimeng_list_models",
      "jimeng_generate_image",
      "jimeng_generate_video",
    ]);
    expect(result.tools.find((tool) => tool.name === "jimeng_generate_image")?.annotations)
      .toMatchObject({ destructiveHint: true, idempotentHint: false });
  });

  it("defaults image generation to exact mode and reports observed paid usage", async () => {
    const generateImage = vi.fn().mockResolvedValue({
      created: 123,
      urls: ["https://example.com/image.png"],
    });
    const getBalance = vi.fn()
      .mockResolvedValueOnce(balanceBefore)
      .mockResolvedValueOnce(balanceAfter);
    const client = await connect({
      getBalance,
      listModels: vi.fn(),
      generateImage,
      generateVideo: vi.fn(),
    });

    const result = await client.callTool({
      name: "jimeng_generate_image",
      arguments: { prompt: "a test image" },
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "jimeng-image-5.0-lite",
        prompt: "a test image",
        allowFallback: false,
      })
    );
    expect(result.isError).not.toBe(true);
    const content = result.content[0];
    expect(content.type).toBe("text");
    if (content.type !== "text") throw new Error("Expected text tool output");
    const output = JSON.parse(content.text);
    expect(output.observedCreditsUsed.purchaseCredit).toBe(6);
    expect(output.observedCreditsUsed.totalCredit).toBe(6);
    expect(JSON.stringify(output)).not.toContain("session");
  });
});
