import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "same-server-name", version: "1" });
server.registerTool("echo", { description: "Returns input", inputSchema: { value: z.unknown() } }, async ({ value }) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { value } }));
server.registerTool("add", { description: "Adds numbers", inputSchema: { left: z.number(), right: z.number() } }, async ({ left, right }) => ({ content: [{ type: "text", text: String(left + right) }], structuredContent: { sum: left + right } }));
server.registerTool("fail", { inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "controlled failure" }] }));
server.registerTool("slow", { inputSchema: {} }, async () => { await new Promise((resolve) => setTimeout(resolve, 60000)); return { content: [{ type: "text", text: "late" }] }; });
await server.connect(new StdioServerTransport());
