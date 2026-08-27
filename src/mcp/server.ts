import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { JimengApiClient, JimengCreditBalance } from "./client.ts";

type JimengClient = Pick<
  JimengApiClient,
  "getBalance" | "listModels" | "generateImage" | "generateVideo"
>;

const imageDataUrlSchema = z
  .string()
  .min(1)
  .describe("PNG, JPEG, or WebP base64 data URL; local paths and remote URLs are not accepted");

const imageRatioSchema = z.enum(["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]);
const videoRatioSchema = z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function successResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function getObservedCreditUsage(before: JimengCreditBalance, after: JimengCreditBalance) {
  return {
    giftCredit: Math.max(0, before.giftCredit - after.giftCredit),
    purchaseCredit: Math.max(0, before.purchaseCredit - after.purchaseCredit),
    vipCredit: Math.max(0, before.vipCredit - after.vipCredit),
    totalCredit: Math.max(0, before.totalCredit - after.totalCredit),
  };
}

async function getBalanceAfterGeneration(client: JimengClient) {
  try {
    return await client.getBalance();
  } catch {
    return undefined;
  }
}

export function createJimengMcpServer(client: JimengClient) {
  const server = new McpServer({
    name: "jimeng-paid-api",
    version: "0.0.6",
  });

  server.registerTool(
    "jimeng_get_balance",
    {
      title: "Jimeng account balance",
      description: "Get gift, purchased, VIP, and total credits for the configured Jimeng account.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        return successResult(await client.getBalance());
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "jimeng_list_models",
    {
      title: "List Jimeng models",
      description: "List available Jimeng image or video models and supported resolutions.",
      inputSchema: z.object({
        type: z.enum(["image", "video"]).optional(),
        refresh: z.boolean().default(false).describe("Refresh model metadata from Jimeng before returning"),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ type, refresh }) => {
      try {
        return successResult({ models: await client.listModels({ type, refresh }) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "jimeng_generate_image",
    {
      title: "Generate an image with Jimeng",
      description: "Generate images with the configured paid Jimeng account. This consumes account credits.",
      inputSchema: z.object({
        prompt: z.string().min(1).max(10000),
        model: z.string().min(1).max(128).default("jimeng-image-5.0-lite"),
        negative_prompt: z.string().max(5000).optional(),
        ratio: imageRatioSchema.optional(),
        resolution: z.string().min(1).max(16).optional(),
        sample_strength: z.number().min(0).max(1).optional(),
        reference_image_data_url: imageDataUrlSchema.optional(),
        allow_fallback: z
          .boolean()
          .default(false)
          .describe("Allow automatic lower-resolution retry when credits are insufficient"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      prompt,
      model,
      negative_prompt,
      ratio,
      resolution,
      sample_strength,
      reference_image_data_url,
      allow_fallback,
    }) => {
      try {
        const balanceBefore = await client.getBalance();
        if (balanceBefore.totalCredit <= 0) throw new Error("Jimeng account has no credits");
        const media = await client.generateImage({
          prompt,
          model,
          negativePrompt: negative_prompt,
          ratio,
          resolution,
          sampleStrength: sample_strength,
          referenceImageDataUrl: reference_image_data_url,
          allowFallback: allow_fallback,
        });
        const balanceAfter = await getBalanceAfterGeneration(client);
        return successResult({
          ...media,
          balanceBefore,
          balanceAfter,
          observedCreditsUsed: balanceAfter
            ? getObservedCreditUsage(balanceBefore, balanceAfter)
            : undefined,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "jimeng_generate_video",
    {
      title: "Generate a video with Jimeng",
      description:
        "Generate a video with the configured paid Jimeng account. This consumes credits and may take up to 20 minutes.",
      inputSchema: z.object({
        prompt: z.string().min(1).max(10000),
        model: z.string().min(1).max(128).default("jimeng-video-seedance-2.0-mini"),
        ratio: videoRatioSchema.optional(),
        resolution: z.string().min(1).max(16).optional(),
        duration: z.union([z.literal(5), z.literal(10)]).default(5),
        frame_image_data_urls: z.array(imageDataUrlSchema).max(2).default([]),
        allow_fallback: z
          .boolean()
          .default(false)
          .describe("Allow automatic lower-duration or lower-resolution retry when credits are insufficient"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ prompt, model, ratio, resolution, duration, frame_image_data_urls, allow_fallback }) => {
      try {
        const balanceBefore = await client.getBalance();
        if (balanceBefore.totalCredit <= 0) throw new Error("Jimeng account has no credits");
        const media = await client.generateVideo({
          prompt,
          model,
          ratio,
          resolution,
          duration,
          frameImageDataUrls: frame_image_data_urls,
          allowFallback: allow_fallback,
        });
        const balanceAfter = await getBalanceAfterGeneration(client);
        return successResult({
          ...media,
          balanceBefore,
          balanceAfter,
          observedCreditsUsed: balanceAfter
            ? getObservedCreditUsage(balanceBefore, balanceAfter)
            : undefined,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}
