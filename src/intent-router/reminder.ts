import { resolveUserTimezone } from "../agents/date-time.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const REMINDER_SERVER = "workspace-reminder";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const REMINDER_VERB_RE =
  /(提醒我|提醒一下|叫我|叫一下我|通知我|设个提醒|定个提醒|到点提醒我|帮我提醒)/;
const DELETE_REMINDER_RE = /(删掉|删除|取消|移除|去掉|关掉|关闭|停掉)/;
const DELETE_REMINDER_NOUN_RE = /(任务|提醒|定时任务|日程|闹钟)/;
const DELETE_REMINDER_NOUN_GLOBAL_RE = /(任务|提醒|定时任务|日程|闹钟)/g;
const DELETE_REMINDER_PRONOUN_RE = /^(这个|这条|这个任务|这条任务|这个提醒|这条提醒)$/;
const RECURRING_RE =
  /(每天|每日|工作日|每周|每星期|每隔\s*[零一二三四五六七八九十两\d]+\s*(分钟|小时|天))/;
const WEEKDAY_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
};

export type IntentRouteDecision =
  | { action: "pass"; confidence: number; reason: string }
  | {
      action: "clarify";
      confidence: number;
      question: string;
      missing: string[];
      reason: string;
    }
  | {
      action: "call_tool";
      confidence: number;
      routeId: "reminder.once" | "reminder.recurring" | "reminder.list";
      server: typeof REMINDER_SERVER;
      tool: "create_reminder" | "create_recurring_reminder" | "list_reminders";
      arguments: Record<string, unknown>;
      confirmationText: string;
      dedupeKey: string;
      reason: string;
    }
  | {
      action: "delete_reminder";
      confidence: number;
      routeId: "reminder.delete";
      targetHint?: string;
      referencedText?: string;
      confirmationText: string;
      dedupeKey: string;
      reason: string;
    };

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type ParsedTime =
  | { kind: "relative"; triggerAt: string; label: string }
  | { kind: "absolute"; dateTime: string; label: string };

type ParsedRecurring =
  | { kind: "cron"; cronExpr: string; label: string }
  | { kind: "every"; every: string; label: string };

export function routeReminderIntent(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  nowMs?: number;
}): IntentRouteDecision {
  if (!params.cfg.mcp?.servers?.[REMINDER_SERVER]) {
    return { action: "pass", confidence: 0, reason: "workspace_reminder_mcp_not_configured" };
  }
  const text = getMessageText(params.ctx);
  if (!text) {
    return { action: "pass", confidence: 0, reason: "empty_text" };
  }
  if (!REMINDER_VERB_RE.test(text)) {
    return { action: "pass", confidence: 0.1, reason: "not_reminder_intent" };
  }

  const timezone = resolveUserTimezone(
    params.cfg.agents?.defaults?.userTimezone || DEFAULT_TIMEZONE,
  );
  const title = extractReminderTitle(text);
  const delivery = resolveDeliveryDefaults(params.ctx);
  const commonArgs = {
    title,
    message: title ? `提醒你：${title}` : "提醒你。",
    timezone,
    deliveryChannel: delivery.channel,
    deliveryTarget: delivery.target,
    accountId: delivery.accountId,
    sessionTarget: "isolated",
    wakeMode: "now",
    agentId: params.agentId,
  };

  if (RECURRING_RE.test(text)) {
    const recurring = parseRecurring(text);
    if (!recurring) {
      return {
        action: "clarify",
        confidence: 0.78,
        question: "你想让我按什么频率、几点提醒你？",
        missing: ["recurring_schedule"],
        reason: "recurring_schedule_missing",
      };
    }
    const args =
      recurring.kind === "cron"
        ? { ...commonArgs, cronExpr: recurring.cronExpr }
        : { ...commonArgs, every: recurring.every };
    return {
      action: "call_tool",
      confidence: 0.94,
      routeId: "reminder.recurring",
      server: REMINDER_SERVER,
      tool: "create_recurring_reminder",
      arguments: args,
      confirmationText: `已设置重复提醒：${recurring.label}，${title || "提醒你"}`,
      dedupeKey: buildDedupeKey(params.ctx, "reminder.recurring", recurring.label, title),
      reason: "matched_recurring_reminder",
    };
  }

  const parsedTime = parseOneShotTime(text, {
    nowMs: params.nowMs ?? Date.now(),
    timezone,
  });
  if (!parsedTime) {
    return {
      action: "clarify",
      confidence: 0.82,
      question: "你想让我几点提醒你？",
      missing: ["time"],
      reason: "one_shot_time_missing",
    };
  }

  return {
    action: "call_tool",
    confidence: 0.95,
    routeId: "reminder.once",
    server: REMINDER_SERVER,
    tool: "create_reminder",
    arguments:
      parsedTime.kind === "relative"
        ? { ...commonArgs, triggerAt: parsedTime.triggerAt, deleteAfterRun: true }
        : { ...commonArgs, dateTime: parsedTime.dateTime, deleteAfterRun: true },
    confirmationText: `已设置提醒：${parsedTime.label}，${title || "提醒你"}`,
    dedupeKey: buildDedupeKey(params.ctx, "reminder.once", parsedTime.label, title),
    reason: "matched_one_shot_reminder",
  };
}

export function routeDeleteReminderIntent(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
}): IntentRouteDecision | null {
  const text = getMessageText(params.ctx);
  if (!text || !DELETE_REMINDER_RE.test(text)) {
    return null;
  }
  const targetHint = extractDeleteReminderTargetHint(text);
  const referencedText = normalizeOptionalString(params.ctx.ReplyToBody);
  if (!targetHint && !referencedText && !DELETE_REMINDER_NOUN_RE.test(text)) {
    return null;
  }
  if (!targetHint && !referencedText) {
    return {
      action: "clarify",
      confidence: 0.78,
      question: "你想删掉哪个提醒或任务？",
      missing: ["reminder_target"],
      reason: "delete_reminder_target_missing",
    };
  }
  const dedupeLabel = targetHint || referencedText || "current";
  return {
    action: "delete_reminder",
    confidence: targetHint ? 0.92 : 0.86,
    routeId: "reminder.delete",
    targetHint: targetHint || undefined,
    referencedText: referencedText || undefined,
    confirmationText: "删除中…",
    dedupeKey: buildDedupeKey(params.ctx, "reminder.delete", dedupeLabel, ""),
    reason: targetHint ? "matched_delete_reminder_intent" : "matched_delete_reminder_reply_intent",
  };
}

const QUERY_RE =
  /(((查|看|列)(一下|下|一看)?|查看|看看|列出)(当前|现在|现有)?(已创建的)?(全部|所有)?(的)?(提醒|任务|待办|定时任务)|(当前|现在|现有)(有哪些|有什么)?(已创建的)?(全部|所有)?(提醒|任务|待办|定时任务)|今[天日](有|的)?(什么|啥)?(任务|提醒|待办)|看[一下看]?今[天日]?(有什么|有啥)?(任务|提醒|待办)|(有什么|有啥|有哪些)(提醒|任务|待办))/;
const TODAY_QUALIFIER_RE = /今[天日]/;
const ALL_QUALIFIER_RE = /(所有|全部)/;

export function routeListRemindersIntent(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  agentId: string;
}): IntentRouteDecision | null {
  if (!params.cfg.mcp?.servers?.[REMINDER_SERVER]) {
    return null;
  }
  const text = getMessageText(params.ctx);
  if (!text || !QUERY_RE.test(text)) {
    return null;
  }
  const filter = ALL_QUALIFIER_RE.test(text)
    ? "all"
    : TODAY_QUALIFIER_RE.test(text)
      ? "today"
      : "upcoming";
  const dedupeBase = [
    normalizeOptionalString(params.ctx.SessionKey) ?? "",
    normalizeOptionalString(params.ctx.MessageSidFull) ??
      normalizeOptionalString(params.ctx.MessageSid) ??
      "",
  ].join("|");
  return {
    action: "call_tool",
    confidence: 0.88,
    routeId: "reminder.list",
    server: REMINDER_SERVER,
    tool: "list_reminders",
    arguments: { filter },
    confirmationText: "查询中…",
    dedupeKey: `reminder.list|${dedupeBase}|${filter}`,
    reason: "matched_list_reminders_intent",
  };
}

function getMessageText(ctx: FinalizedMsgContext): string {
  return (
    normalizeOptionalString(ctx.BodyForCommands) ??
    normalizeOptionalString(ctx.CommandBody) ??
    normalizeOptionalString(ctx.RawBody) ??
    normalizeOptionalString(ctx.Body) ??
    ""
  );
}

function resolveDeliveryDefaults(ctx: FinalizedMsgContext): {
  channel?: string;
  target?: string;
  accountId?: string;
} {
  return {
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
}

function buildDedupeKey(
  ctx: FinalizedMsgContext,
  routeId: string,
  scheduleLabel: string,
  title: string,
): string {
  return [
    routeId,
    normalizeOptionalString(ctx.SessionKey) ?? "",
    normalizeOptionalString(ctx.MessageSidFull) ?? normalizeOptionalString(ctx.MessageSid) ?? "",
    scheduleLabel,
    title,
  ].join("|");
}

function extractReminderTitle(text: string): string {
  let next = text.replace(REMINDER_VERB_RE, " ");
  next = next
    .replace(/每隔\s*[零一二三四五六七八九十两\d]+\s*(分钟|小时|天)/g, " ")
    .replace(/每(天|日|周|星期)[一二三四五六日天]?/g, " ")
    .replace(/工作日/g, " ")
    .replace(/(今天|明天|后天|今晚|今早|明早|早上|上午|中午|下午|傍晚|晚上|凌晨)/g, " ")
    .replace(/[零一二三四五六七八九十两\d]{1,3}\s*点半?/g, " ")
    .replace(
      /[零一二三四五六七八九十两\d]{1,3}\s*点\s*[零一二三四五六七八九十两\d]{1,3}\s*分?/g,
      " ",
    )
    .replace(/\d{1,2}:\d{2}/g, " ")
    .replace(/(半|[零一二三四五六七八九十两\d]+)\s*(分钟|小时|天)后/g, " ")
    .replace(/^(请|麻烦|帮我|到时候|记得|在|到|一下)+/g, " ")
    .replace(/[，,。.!！?？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return next || "提醒";
}

function extractDeleteReminderTargetHint(text: string): string {
  const quotedMatch = text.match(/[“"「『]([^“”"「」『』]+)[”"」』]/);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  let next = text.replace(DELETE_REMINDER_RE, " ");
  next = next
    .replace(/[“”‘’「」『』（）()【】[\]]/g, " ")
    .replace(DELETE_REMINDER_NOUN_GLOBAL_RE, " ")
    .replace(/[零一二三四五六七八九十两\d]+\s*(分钟|小时|天|周|星期)(后|内)?(的)?/g, " ")
    .replace(/(明天|今天|今晚|今早|早上|上午|中午|下午|晚上|稍后|待会|一会儿)(的)?/g, " ")
    .replace(/(吧|一下|帮我|麻烦|请|先|给我|把)/g, " ")
    .replace(/(这个|这条)/g, " ")
    .replace(/[，,。.!！?？:："'`~·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!next || DELETE_REMINDER_PRONOUN_RE.test(next)) {
    return "";
  }
  return next;
}

function parseOneShotTime(
  text: string,
  params: { nowMs: number; timezone: string },
): ParsedTime | null {
  const relative = text.match(/(半|[零一二三四五六七八九十两\d]+)\s*(分钟|小时|天)后/);
  if (relative) {
    const isHalf = relative[1] === "半";
    const amount = isHalf ? 30 : parseChineseNumber(relative[1] ?? "");
    const unit = relative[2] ?? "";
    if (!amount) {
      return null;
    }
    if (isHalf && unit === "小时") {
      return { kind: "relative", triggerAt: "30m", label: "半小时后" };
    }
    if (unit === "分钟") {
      return { kind: "relative", triggerAt: `${amount}m`, label: `${amount}分钟后` };
    }
    if (unit === "小时") {
      return { kind: "relative", triggerAt: `${amount}h`, label: `${amount}小时后` };
    }
    if (unit === "天") {
      return { kind: "relative", triggerAt: `${amount}d`, label: `${amount}天后` };
    }
  }

  const time = parseClockTime(text);
  if (!time) {
    return null;
  }
  const now = getZonedParts(params.nowMs, params.timezone);
  const explicitDayOffset = resolveDayOffset(text);
  let dayOffset = explicitDayOffset ?? 0;
  if (explicitDayOffset === undefined && isWallTimePastOrNow(now, time)) {
    dayOffset = 1;
  }
  const target = addDays(now, dayOffset);
  const dateTime = `${pad4(target.year)}-${pad2(target.month)}-${pad2(target.day)}T${pad2(time.hour)}:${pad2(time.minute)}:00`;
  const label =
    `${dayLabel(dayOffset, explicitDayOffset !== undefined)} ${pad2(time.hour)}:${pad2(time.minute)}`.trim();
  return { kind: "absolute", dateTime, label };
}

function parseRecurring(text: string): ParsedRecurring | null {
  const every = text.match(/每隔\s*([零一二三四五六七八九十两\d]+)\s*(分钟|小时|天)/);
  if (every) {
    const amount = parseChineseNumber(every[1] ?? "");
    const unit = every[2] ?? "";
    if (!amount) {
      return null;
    }
    const suffix = unit === "分钟" ? "m" : unit === "小时" ? "h" : "d";
    return { kind: "every", every: `${amount}${suffix}`, label: `每隔${amount}${unit}` };
  }

  const time = parseClockTime(text);
  if (!time) {
    return null;
  }
  if (/工作日/.test(text)) {
    return {
      kind: "cron",
      cronExpr: `${time.minute} ${time.hour} * * 1-5`,
      label: `工作日 ${pad2(time.hour)}:${pad2(time.minute)}`,
    };
  }
  const weekly = text.match(/每(?:周|星期)\s*([一二三四五六日天])/);
  if (weekly) {
    const weekday = WEEKDAY_MAP[weekly[1] ?? ""];
    if (weekday === undefined) {
      return null;
    }
    return {
      kind: "cron",
      cronExpr: `${time.minute} ${time.hour} * * ${weekday}`,
      label: `每周${weekly[1]} ${pad2(time.hour)}:${pad2(time.minute)}`,
    };
  }
  if (/(每天|每日)/.test(text)) {
    return {
      kind: "cron",
      cronExpr: `${time.minute} ${time.hour} * * *`,
      label: `每天 ${pad2(time.hour)}:${pad2(time.minute)}`,
    };
  }
  return null;
}

function parseClockTime(text: string): { hour: number; minute: number } | null {
  const colon = text.match(/(\d{1,2})\s*:\s*(\d{2})/);
  let hour: number | null = null;
  let minute = 0;
  if (colon) {
    hour = Number.parseInt(colon[1] ?? "", 10);
    minute = Number.parseInt(colon[2] ?? "", 10);
  } else {
    const point = text.match(
      /([零一二三四五六七八九十两\d]{1,3})\s*点\s*(半|[零一二三四五六七八九十两\d]{1,3}\s*分?)?/,
    );
    if (!point) {
      return null;
    }
    hour = parseChineseNumber(point[1] ?? "");
    const minuteRaw = (point[2] ?? "").replace(/\s/g, "");
    minute =
      minuteRaw === "半" ? 30 : minuteRaw ? parseChineseNumber(minuteRaw.replace(/分$/, "")) : 0;
  }
  if (hour === null || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (/(下午|晚上|今晚|傍晚)/.test(text) && hour >= 1 && hour < 12) {
    hour += 12;
  } else if (/中午/.test(text) && hour >= 1 && hour < 11) {
    hour += 12;
  } else if (/(凌晨|早上|上午|今早|明早)/.test(text) && hour === 12) {
    hour = 0;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function resolveDayOffset(text: string): number | undefined {
  if (/后天/.test(text)) {
    return 2;
  }
  if (/明天|明早/.test(text)) {
    return 1;
  }
  if (/今天|今晚|今早/.test(text)) {
    return 0;
  }
  return undefined;
}

function isWallTimePastOrNow(now: ZonedParts, time: { hour: number; minute: number }) {
  return time.hour < now.hour || (time.hour === now.hour && time.minute <= now.minute);
}

function addDays(parts: ZonedParts, days: number): ZonedParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function getZonedParts(ms: number, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(ms));
  const get = (type: string) =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function parseChineseNumber(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (trimmed === "半") {
    return 30;
  }
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (trimmed === "十") {
    return 10;
  }
  const tenIndex = trimmed.indexOf("十");
  if (tenIndex >= 0) {
    const left = trimmed.slice(0, tenIndex);
    const right = trimmed.slice(tenIndex + 1);
    const tens = left ? (digits[left] ?? 0) : 1;
    const ones = right ? (digits[right] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return digits[trimmed] ?? 0;
}

function dayLabel(offset: number, explicit: boolean): string {
  if (offset === 0) {
    return explicit ? "今天" : "";
  }
  if (offset === 1) {
    return "明天";
  }
  if (offset === 2) {
    return "后天";
  }
  return `${offset}天后`;
}

const pad2 = (value: number) => String(value).padStart(2, "0");
const pad4 = (value: number) => String(value).padStart(4, "0");
