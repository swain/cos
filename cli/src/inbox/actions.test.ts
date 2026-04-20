import { describe, expect, it } from "vitest";
import { parsePlannotatorAnnotateStdout } from "./actions.js";

describe("parsePlannotatorAnnotateStdout", () => {
  it("treats empty stdout as approve", () => {
    expect(parsePlannotatorAnnotateStdout("")).toEqual({ kind: "approve" });
    expect(parsePlannotatorAnnotateStdout("   \n  ")).toEqual({
      kind: "approve",
    });
  });

  it("treats the 'No changes detected.' sentinel as approve", () => {
    expect(parsePlannotatorAnnotateStdout("No changes detected.")).toEqual({
      kind: "approve",
    });
    expect(parsePlannotatorAnnotateStdout("No changes detected.\n")).toEqual({
      kind: "approve",
    });
  });

  it("treats the 'No feedback provided.' sentinel as approve", () => {
    expect(parsePlannotatorAnnotateStdout("No feedback provided.")).toEqual({
      kind: "approve",
    });
  });

  it("returns the trimmed feedback body when plannotator emitted annotations", () => {
    const body = "## Plan Feedback\n\n- line 4: tighten this\n";
    expect(parsePlannotatorAnnotateStdout(`\n${body}\n`)).toEqual({
      kind: "feedback",
      body: body.trim(),
    });
  });
});
