import crypto from "node:crypto";
import { callGatewayTool } from "../agents/tools/gateway.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { logVerbose } from "../globals.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { callConfiguredMcpTool } from "./mcp.js";
import {
  routeDeleteReminderIntent,
  routeListRemindersIntent,
  routeReminderIntent,
} from "./reminder.js";

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
  let decision =
    routeDeleteReminderIntent({
      ctx: params.ctx,
      cfg: params.cfg,
    }) ??
    routeReminderIntent({
      ctx: params.ctx,
      cfg: params.cfg,
      agentId: params.agentId,
    });
  logVerbose(
    `intent-router: decision action=${decision.action} confidence=${decision.confidence} reason=${decision.reason}`,
  );

  if (decision.action === "pass") {
    const listDecision = routeListRemindersIntent({
      ctx: params.ctx,
      cfg: params.cfg,
      agentId: params.agentId,
    });
    if (listDecision) {
      decision = listDecision;
    }
  }

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

  if (decision.action === "delete_reminder") {
    const deleted = await deleteReminderFromIntent({
      ctx: params.ctx,
      targetHint: decision.targetHint,
      referencedText: decision.referencedText,
    });
    recentCommittedRoutes.set(dedupeKey, now);
    return {
      handled: true,
      reason: decision.reason,
      reply: { text: deleted },
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
  const filterArg =
    typeof decision.arguments.filter === "string" ? decision.arguments.filter : "all";
  const replyText =
    decision.routeId === "reminder.list"
      ? formatListReply(result, filterArg)
      : decision.confirmationText;
  return {
    handled: true,
    reason: decision.reason,
    reply: { text: replyText },
  };
}

async function deleteReminderFromIntent(params: {
  ctx: FinalizedMsgContext;
  targetHint?: string;
  referencedText?: string;
}): Promise<string> {
  const jobs = await loadCronJobs();
  const scopedJobs = jobs.filter((job) => matchesCurrentRoute(job, params.ctx));
  const candidates = (scopedJobs.length > 0 ? scopedJobs : jobs).filter((job) =>
    looksLikeReminderJob(job),
  );
  if (candidates.length === 0) {
    return "暂时没找到可删除的提醒任务。";
  }
  const match = selectReminderDeletionTarget({
    jobs: candidates,
    targetHint: params.targetHint,
    referencedText: params.referencedText,
  });
  if (match.kind === "none") {
    return "我没定位到你要删除的是哪条提醒。你可以把提醒名称发我，或者直接回复那条提醒消息说“删掉这个任务”。";
  }
  if (match.kind === "ambiguous") {
    const labels = match.jobs
      .slice(0, 3)
      .map((job) => job.name || extractJobMessage(job) || job.id)
      .join("、");
    return `我找到了多个可能的提醒：${labels}。你回我更具体一点的名称，我再帮你删。`;
  }
  const result = await callGatewayTool("cron.remove", {}, { id: match.job.id });
  if (!result?.removed) {
    return "我刚刚尝试删除这条提醒，但它可能已经不存在了。";
  }
  return `已删除提醒：${match.job.name || extractJobMessage(match.job) || match.job.id}`;
}

async function loadCronJobs(): Promise<CronJob[]> {
  const jobs: CronJob[] = [];
  let offset = 0;
  for (;;) {
    const page = await callGatewayTool(
      "cron.list",
      {},
      {
        includeDisabled: true,
        limit: 200,
        offset,
      },
    );
    jobs.push(...(Array.isArray(page?.jobs) ? page.jobs : []));
    if (!page?.hasMore || typeof page.nextOffset !== "number") {
      break;
    }
    offset = page.nextOffset;
  }
  return jobs;
}

function looksLikeReminderJob(job: CronJob): boolean {
  return Boolean(job?.name || extractJobMessage(job));
}

function matchesCurrentRoute(job: CronJob, ctx: FinalizedMsgContext): boolean {
  const currentChannel =
    normalizeOptionalString(ctx.OriginatingChannel) ??
    normalizeOptionalString(ctx.Surface) ??
    normalizeOptionalString(ctx.Provider);
  const currentTarget =
    normalizeOptionalString(ctx.OriginatingTo) ??
    normalizeOptionalString(ctx.From) ??
    normalizeOptionalString(ctx.To);
  const currentAccount = normalizeOptionalString(ctx.AccountId);
  const jobChannel = normalizeOptionalString(job.delivery?.channel);
  const jobTarget = normalizeOptionalString(job.delivery?.to);
  const jobAccount = normalizeOptionalString(job.delivery?.accountId);
  return Boolean(
    currentTarget &&
    jobTarget &&
    currentTarget === jobTarget &&
    (!currentChannel || !jobChannel || currentChannel === jobChannel) &&
    (!currentAccount || !jobAccount || currentAccount === jobAccount),
  );
}

function extractJobMessage(job: CronJob): string {
  if (job.payload.kind === "agentTurn") {
    return job.payload.message;
  }
  return job.payload.text;
}

function normalizeNeedle(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[“”‘’「」『』（）()【】[\]]/g, " ")
    .replace(/[，,。.!！?？:："'`~·]/g, " ")
    .replace(/\s+/g, " ");
}

function selectReminderDeletionTarget(params: {
  jobs: CronJob[];
  targetHint?: string;
  referencedText?: string;
}): { kind: "none" } | { kind: "ambiguous"; jobs: CronJob[] } | { kind: "match"; job: CronJob } {
  const targets = [params.targetHint, params.referencedText]
    .map((value) => normalizeNeedle(value))
    .filter(Boolean);
  if (targets.length === 0) {
    return { kind: "none" };
  }
  const scored = params.jobs
    .map((job) => ({ job, score: scoreReminderDeletionJob(job, targets) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score);
  if (scored.length === 0) {
    return { kind: "none" };
  }
  if (scored.length > 1 && scored[0]?.score === scored[1]?.score) {
    return {
      kind: "ambiguous",
      jobs: scored.filter((entry) => entry.score === scored[0]?.score).map((entry) => entry.job),
    };
  }
  return { kind: "match", job: scored[0].job };
}

function scoreReminderDeletionJob(job: CronJob, targets: string[]): number {
  const haystacks = [
    normalizeNeedle(job.id),
    normalizeNeedle(job.name),
    normalizeNeedle(extractJobMessage(job)),
  ].filter(Boolean);
  let best = 0;
  for (const target of targets) {
    for (const haystack of haystacks) {
      if (!target || !haystack) {
        continue;
      }
      if (haystack === target) {
        best = Math.max(best, 100);
      } else if (haystack.includes(target)) {
        best = Math.max(best, 80);
      } else if (target.includes(haystack) && haystack.length >= 4) {
        best = Math.max(best, 70);
      }
    }
  }
  return best;
}

export function resetIntentRouterDedupeForTests() {
  recentCommittedRoutes.clear();
}

function formatListReply(result: unknown, filter: string): string {
  try {
    const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    if (!text) {
      return "暂时没有找到提醒列表。";
    }
    const data = JSON.parse(text) as {
      total: number;
      jobs: Array<{ name: string; nextRunAt: string | null; message: string | null }>;
    };
    if (data.total === 0) {
      return filter === "today" ? "今天没有安排的提醒。" : "暂时没有计划中的提醒。";
    }
    const label =
      filter === "today" ? "今天的提醒" : filter === "upcoming" ? "即将到来的提醒" : "所有提醒";
    const lines = data.jobs.map((j) => {
      let time = j.nextRunAt ?? "";
      time =
        filter === "today"
          ? time.replace(/^\d{4}\/\d{2}\/\d{2}\s/, "")
          : time.replace(/^\d{4}\//, "");
      const name = j.name || j.message || "（未命名）";
      return time ? `• ${time} ${name}` : `• ${name}`;
    });
    return `${label}（${data.total}条）：\n${lines.join("\n")}`;
  } catch {
    return "查询提醒列表时出错。";
  }
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
