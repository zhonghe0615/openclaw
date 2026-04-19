export const TOOL_COMMITMENT_CAPABILITIES = {
  REMINDER_CREATE: "reminder.create",
  TASK_SCHEDULE_ONCE: "task.schedule.once",
} as const;

export type ToolCommitmentCapability =
  (typeof TOOL_COMMITMENT_CAPABILITIES)[keyof typeof TOOL_COMMITMENT_CAPABILITIES];

export type ToolCommitmentCapabilityDefinition = {
  id: ToolCommitmentCapability;
  description: string;
  commitmentKind: ToolCommitmentCapability;
  risks: Array<"schedule" | "external-send">;
};

export const TOOL_COMMITMENT_CAPABILITY_CATALOG: Record<
  ToolCommitmentCapability,
  ToolCommitmentCapabilityDefinition
> = {
  [TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE]: {
    id: TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE,
    description: "Creates a user-visible reminder.",
    commitmentKind: TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE,
    risks: ["schedule", "external-send"],
  },
  [TOOL_COMMITMENT_CAPABILITIES.TASK_SCHEDULE_ONCE]: {
    id: TOOL_COMMITMENT_CAPABILITIES.TASK_SCHEDULE_ONCE,
    description: "Schedules a one-shot task for future execution.",
    commitmentKind: TOOL_COMMITMENT_CAPABILITIES.TASK_SCHEDULE_ONCE,
    risks: ["schedule"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function isToolCommitmentCapability(value: unknown): value is ToolCommitmentCapability {
  return typeof value === "string" && Object.hasOwn(TOOL_COMMITMENT_CAPABILITY_CATALOG, value);
}

export function hasToolCommitmentCapability(
  value: unknown,
  capability: ToolCommitmentCapability,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.capability === capability) {
    return true;
  }
  if (
    Array.isArray(value.capabilities) &&
    value.capabilities.some((entry) => entry === capability)
  ) {
    return true;
  }
  const commitment = value.commitment;
  return isRecord(commitment) && commitment.kind === capability && commitment.status === "success";
}

export function toolResultHasCommitmentCapability(params: {
  result: unknown;
  capability: ToolCommitmentCapability;
}): boolean {
  if (!isRecord(params.result)) {
    return false;
  }
  const details = params.result.details;
  if (!isRecord(details)) {
    return false;
  }
  return hasToolCommitmentCapability(details.structuredContent, params.capability);
}
