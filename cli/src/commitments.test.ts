import { describe, expect, it } from "vitest";
import {
  parseLedger,
  serializeLedger,
  parseLine,
  formatLine,
  type Commitment,
} from "./commitments.js";

const sample = `# Commitments

## Active

- [ ] c-4F7Q2A | feliks | deliver Win onboarding design doc | due:2026-06-13 | src:synchro-win-2026-06-12 | added:2026-06-12
- [ ] c-9K2M1B | swain | follow up with Tomer | src:po-vocative | added:2026-06-12

## Archive

- [x] c-1A2B3C | swain | example done item | added:2026-06-10
`;

describe("parseLine", () => {
  it("parses a full line", () => {
    const c = parseLine(
      "- [ ] c-4F7Q2A | feliks | deliver Win onboarding design doc | due:2026-06-13 | src:synchro-win-2026-06-12 | added:2026-06-12",
    );
    expect(c).toEqual({
      id: "c-4F7Q2A",
      who: "feliks",
      what: "deliver Win onboarding design doc",
      due: "2026-06-13",
      source: "synchro-win-2026-06-12",
      added: "2026-06-12",
      done: false,
    });
  });

  it("parses optional segments as null", () => {
    const c = parseLine(
      "- [x] c-1A2B3C | swain | example done item | added:2026-06-10",
    );
    expect(c?.due).toBeNull();
    expect(c?.source).toBeNull();
    expect(c?.done).toBe(true);
  });

  it("returns null for non-commitment lines", () => {
    expect(parseLine("## Active")).toBeNull();
    expect(parseLine("")).toBeNull();
  });
});

describe("parseLedger/serializeLedger round-trip", () => {
  it("round-trips", () => {
    const items = parseLedger(sample);
    expect(items).toHaveLength(3);
    expect(serializeLedger(items)).toBe(sample);
  });

  it("splits active and archive by done flag", () => {
    const items = parseLedger(sample);
    expect(items.filter((c) => !c.done)).toHaveLength(2);
    expect(items.filter((c) => c.done)).toHaveLength(1);
  });
});

describe("formatLine", () => {
  it("omits empty optional segments", () => {
    const c: Commitment = {
      id: "c-AAAAAA",
      who: "swain",
      what: "thing",
      due: null,
      source: null,
      added: "2026-06-12",
      done: false,
    };
    expect(formatLine(c)).toBe(
      "- [ ] c-AAAAAA | swain | thing | added:2026-06-12",
    );
  });
});
