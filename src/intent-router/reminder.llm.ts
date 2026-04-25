import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUserTimezone } from "../agents/date-time.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { IntentRouteDecision } from "./reminder.js";

const REMINDER_SERVER = "workspace-reminder";
const DEFAULT_TIMEZONE = "Asia/Shanghai";

// Broader gate than REMINDER_VERB_RE — catches time/action words the strict verb list misses
// e.g. "睡前叫我", "吃完饭记得", "明天早上别忘了"
const REMINDER_ADJACENT_RE =
  /(提醒|叫我|通知我|记得|别忘|到点|睡前|起床|吃完|开会|下班|[零一二三四五六七八九十两\d]+\s*[点分钟小时天]|明天|今晚|今早|早上|下午|晚上)/;

export function mightBeReminderIntent(text: string): boolean {
  return text.length < 200 && REMINDER_ADJACENT_RE.test(text);
}

type LlmReminderJson =
  | { isReminder: false }
  | {
      isReminder: true;
      title: string;
      triggerAt?: string; // relative: "10m" | "2h" | "1d"
      dateTime?: string; // absolute ISO without tz: "2026-04-25T14:00:00"
      cronExpr?: string; // recurring cron expr
      every?: string; // recurring interval: "30m" | "1h"
    };

function buildClassifyPrompt(text: string, nowLabel: string): string {
  return [
    `You are a reminder intent classifier. Current time (Asia/Shanghai): ${nowLabel}`,
    "Return ONLY valid JSON, no markdown, no commentary.",
    "",
    "Schemas:",
    '  Not a reminder:               {"isReminder":false}',
    '  One-time relative ("10分钟后"): {"isReminder":true,"title":"<task>","triggerAt":"<Nm|Nh|Nd>"}',
    '  One-time absolute ("明天9点"):  {"isReminder":true,"title":"<task>","dateTime":"<YYYY-MM-DDTHH:MM:00>"}',
    '  Recurring cron:               {"isReminder":true,"title":"<task>","cronExpr":"<expr>"}',
    '  Recurring interval:           {"isReminder":true,"title":"<task>","every":"<Nm|Nh|Nd>"}',
    "",
    `User message: ${JSON.stringify(text)}`,
  ].join("\n");
}

export async function tryLlmReminderFallback(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  nowMs?: number;
}): Promise<IntentRouteDecision | null> {
  const text =
    normalizeOptionalString(params.ctx.BodyForCommands) ??
    normalizeOptionalString(params.ctx.CommandBody) ??
    normalizeOptionalString(params.ctx.RawBody) ??
    normalizeOptionalString(params.ctx.Body) ??
    "";
  if (!text || !mightBeReminderIntent(text)) {
    return null;
  }

  let tmpDir: string | null = null;
  try {
    const { runEmbeddedPiAgent } = await import("../agents/pi-embedded.runtime.js");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-intent-"));
    const sessionId = `intent-classify-${Date.now()}`;
    const sessionFile = path.join(tmpDir, "session.json");
    const nowMs = params.nowMs ?? Date.now();
    const nowLabel = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(nowMs));

    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      provider: "codex",
      model: "gpt-5.4-mini",
      disableTools: true,
      bootstrapContextMode: "lightweight",
      prompt: buildClassifyPrompt(text, nowLabel),
      runId: sessionId,
      timeoutMs: 15_000,
    });

    const payloads =
      typeof result === "object" && result !== null && "payloads" in result
        ? (result as { payloads?: Array<{ text?: string; isError?: boolean }> }).payloads
        : undefined;

    const raw = (payloads ?? [])
      .filter((p) => !p.isError && typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");

    let parsed: LlmReminderJson;
    try {
      parsed = JSON.parse(raw) as LlmReminderJson;
    } catch {
      return null;
    }

    if (!parsed.isReminder) {
      return null;
    }
    return buildDecision(parsed, params);
  } catch {
    return null;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function buildDecision(
  parsed: Extract<LlmReminderJson, { isReminder: true }>,
  params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    agentId: string;
  },
): IntentRouteDecision | null {
  const { ctx, cfg } = params;
  const title = (parsed.title || "提醒").trim();
  const timezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone || DEFAULT_TIMEZONE);

  const delivery = {
    channel:
      normalizeOptionalString(ctx.OriginatingChannel) ??
      normalizeOptionalString(ctx.Surface) ??
      normalizeOptionalString(ctx.Provider),
    target:
      normalizeOptionalString(ctx.OriginatingTo) ??
      normalizeOptionalString(ctx.From) ??
      normalizeOptionalString(ctx.To),
    accountId: normalizeOptionalString(ctx.AccountId),
  };

  const commonArgs = {
    title,
    message: `提醒你：${title}`,
    timezone,
    deliveryChannel: delivery.channel,
    deliveryTarget: delivery.target,
    accountId: delivery.accountId,
    sessionTarget: "isolated",
    wakeMode: "now",
    agentId: params.agentId,
  };

  const dedupeBase = [
    normalizeOptionalString(ctx.SessionKey) ?? "",
    normalizeOptionalString(ctx.MessageSidFull) ?? normalizeOptionalString(ctx.MessageSid) ?? "",
    title,
  ].join("|");

  if (parsed.cronExpr) {
    return {
      action: "call_tool",
      confidence: 0.88,
      routeId: "reminder.recurring",
      server: REMINDER_SERVER,
      tool: "create_recurring_reminder",
      arguments: { ...commonArgs, cronExpr: parsed.cronExpr },
      confirmationText: `已设置重复提醒：${title}`,
      dedupeKey: `reminder.recurring|${dedupeBase}|${parsed.cronExpr}`,
      reason: "matched_recurring_reminder_llm",
    };
  }
  if (parsed.every) {
    return {
      action: "call_tool",
      confidence: 0.88,
      routeId: "reminder.recurring",
      server: REMINDER_SERVER,
      tool: "create_recurring_reminder",
      arguments: { ...commonArgs, every: parsed.every },
      confirmationText: `已设置重复提醒：${title}`,
      dedupeKey: `reminder.recurring|${dedupeBase}|${parsed.every}`,
      reason: "matched_recurring_reminder_llm",
    };
  }
  if (parsed.triggerAt) {
    return {
      action: "call_tool",
      confidence: 0.9,
      routeId: "reminder.once",
      server: REMINDER_SERVER,
      tool: "create_reminder",
      arguments: { ...commonArgs, triggerAt: parsed.triggerAt, deleteAfterRun: true },
      confirmationText: `已设置提醒：${title}`,
      dedupeKey: `reminder.once|${dedupeBase}|${parsed.triggerAt}`,
      reason: "matched_one_shot_reminder_llm",
    };
  }
  if (parsed.dateTime) {
    return {
      action: "call_tool",
      confidence: 0.9,
      routeId: "reminder.once",
      server: REMINDER_SERVER,
      tool: "create_reminder",
      arguments: { ...commonArgs, dateTime: parsed.dateTime, deleteAfterRun: true },
      confirmationText: `已设置提醒：${title}`,
      dedupeKey: `reminder.once|${dedupeBase}|${parsed.dateTime}`,
      reason: "matched_one_shot_reminder_llm",
    };
  }
  // LLM said it's a reminder but gave no usable time info
  return null;
}
