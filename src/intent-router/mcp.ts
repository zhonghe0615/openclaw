import crypto from "node:crypto";
import { createSessionMcpRuntime } from "../agents/pi-bundle-mcp-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export async function callConfiguredMcpTool(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  sessionKey?: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}) {
  const runtime = createSessionMcpRuntime({
    sessionId: `intent-router:${crypto.randomUUID()}`,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  try {
    const catalog = await runtime.getCatalog();
    const hasTool = catalog.tools.some(
      (tool) => tool.serverName === params.server && tool.toolName === params.tool,
    );
    if (!hasTool) {
      throw new Error(`MCP tool ${params.server}.${params.tool} is not available`);
    }
    return await runtime.callTool(params.server, params.tool, params.arguments);
  } finally {
    await runtime.dispose();
  }
}
