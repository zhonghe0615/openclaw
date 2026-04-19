import { describe, expect, it } from "vitest";
import {
  TOOL_COMMITMENT_CAPABILITIES,
  TOOL_COMMITMENT_CAPABILITY_CATALOG,
  hasToolCommitmentCapability,
  isToolCommitmentCapability,
  toolResultHasCommitmentCapability,
} from "./tool-commitment-capabilities.js";

describe("tool commitment capability catalog", () => {
  it("defines reminder and one-shot schedule capabilities", () => {
    expect(Object.keys(TOOL_COMMITMENT_CAPABILITY_CATALOG).toSorted()).toEqual([
      "reminder.create",
      "task.schedule.once",
    ]);
    expect(isToolCommitmentCapability(TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE)).toBe(true);
    expect(isToolCommitmentCapability("unknown.capability")).toBe(false);
  });

  it("detects direct capability fields", () => {
    expect(
      hasToolCommitmentCapability(
        { capability: "reminder.create" },
        TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE,
      ),
    ).toBe(true);
  });

  it("detects capability arrays", () => {
    expect(
      hasToolCommitmentCapability(
        { capabilities: ["task.schedule.once", "reminder.create"] },
        TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE,
      ),
    ).toBe(true);
  });

  it("detects successful commitment records", () => {
    expect(
      hasToolCommitmentCapability(
        { commitment: { kind: "reminder.create", status: "success" } },
        TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE,
      ),
    ).toBe(true);
    expect(
      hasToolCommitmentCapability(
        { commitment: { kind: "reminder.create", status: "error" } },
        TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE,
      ),
    ).toBe(false);
  });

  it("detects MCP structuredContent commitment capabilities in tool results", () => {
    expect(
      toolResultHasCommitmentCapability({
        capability: TOOL_COMMITMENT_CAPABILITIES.REMINDER_CREATE,
        result: {
          details: {
            structuredContent: {
              commitment: { kind: "reminder.create", status: "success" },
            },
          },
        },
      }),
    ).toBe(true);
  });
});
