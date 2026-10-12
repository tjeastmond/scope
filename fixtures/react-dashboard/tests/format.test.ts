import { describe, expect, it } from "vitest";
import { formatDelta, formatNumber, formatPercent } from "../src/lib/format";

describe("format", () => {
  it("abbreviates large numbers", () => {
    expect(formatNumber(1500)).toBe("1.5k");
    expect(formatNumber(2_000_000)).toBe("2.0M");
  });

  it("formats percentages with one decimal", () => {
    expect(formatPercent(12.34)).toBe("12.3%");
  });

  it("reports no delta when the previous value is zero", () => {
    expect(formatDelta(5, 0)).toBe("n/a");
  });
});
