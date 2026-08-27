import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createJimengApiClientFromEnv } from "./client.ts";
import { createJimengMcpServer } from "./server.ts";

try {
  const client = createJimengApiClientFromEnv();
  const handle = serveStdio(() => createJimengMcpServer(client));

  process.on("SIGINT", async () => {
    await handle.close();
    process.exit(0);
  });

  console.error("Jimeng MCP server is listening on stdio");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
