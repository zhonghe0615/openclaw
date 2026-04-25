import crypto from "node:crypto";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { callConfiguredMcpTool } from "./mcp.js";
import { routeReminderIntent } from "./reminder.js";

let reminderLlmPromise: Promise<typeof import("./reminder.llm.js")> | null = null;
function loadReminderLlm() {
  reminderLlmPromise ??= import("./reminder.llm.js");
  return reminderLlmPromise;
}

const DEDUPE_TTL_MS = 30_000;
const recentCommittedRoutes = new Map<string, number>();

export async function tryRouteIntentToMcp(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
}): Promise<
  { handled: false; reason: string } | { handled: true; reply: ReplyPayload; reason: string }
> {
  let decision = routeReminderIntent({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
  });
  logVerbose(
    `intent-router: decision action=${decision.action} confidence=${decision.confidence} reason=${decision.reason}`,
  );

  if (decision.action === "pass" && decision.reason === "not_reminder_intent") {
    try {
      const { tryLlmReminderFallback } = await loadReminderLlm();
      const llmDecision = await tryLlmReminderFallback(params);
      if (llmDecision) {
        logVerbose(
          `intent-router: llm fallback matched action=${llmDecision.action} reason=${llmDecision.reason}`,
        );
        decision = llmDecision;
      }
    } catch (err) {
      logVerbose(`intent-router: llm fallback failed: ${String(err)}`);
    }
  }

  if (decision.action === "pass") {
    return { handled: false, reason: decision.reason };
  }
  if (decision.action === "clarify") {
    return {
      handled: true,
      reason: decision.reason,
      reply: { text: decision.question },
    };
  }

  const dedupeKey = hashDedupeKey(decision.dedupeKey);
  const now = Date.now();
  pruneDedupe(now);
  const previous = recentCommittedRoutes.get(dedupeKey);
  if (previous && now - previous < DEDUPE_TTL_MS) {
    return {
      handled: true,
      reason: "duplicate_intent_route",
      reply: { text: "这个提醒刚刚已经设置过了。" },
    };
  }

  const result = await callConfiguredMcpTool({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    sessionKey: params.ctx.SessionKey,
    server: decision.server,
    tool: decision.tool,
    arguments: decision.arguments,
  });
  if (result.isError === true) {
    throw new Error(`MCP tool ${decision.server}.${decision.tool} returned an error`);
  }
  recentCommittedRoutes.set(dedupeKey, now);
  return {
    handled: true,
    reason: decision.reason,
    reply: {
      text: decision.confirmationText,
    },
  };
}

export function resetIntentRouterDedupeForTests() {
  recentCommittedRoutes.clear();
}

function hashDedupeKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function pruneDedupe(now: number) {
  for (const [key, timestamp] of recentCommittedRoutes) {
    if (now - timestamp > DEDUPE_TTL_MS) {
      recentCommittedRoutes.delete(key);
    }
  }
}
