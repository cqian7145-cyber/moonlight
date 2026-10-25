import { describe, expect, it } from "vitest";
import { calculateDuoComparison } from "./results";

describe("calculateDuoComparison", () => {
  it.each([
    { first: [0, 1, 2], second: [0, 1, 2], matchedCount: 3 },
    { first: [0, 0, 0], second: [1, 1, 1], matchedCount: 0 },
    { first: [0, 1, 2], second: [0, 0, 2], matchedCount: 2 },
  ])("counts the shared choices without assigning a relationship score", ({ first, second, matchedCount }) => {
    expect(calculateDuoComparison(first, second)).toMatchObject({ matchedCount, total: 3, message: expect.any(String) });
  });

  it("rejects incomplete or invalid answer sets", () => {
    expect(() => calculateDuoComparison([0, 1], [0, 1, 2])).toThrow(RangeError);
    expect(() => calculateDuoComparison([0, 1, -1], [0, 1, 2])).toThrow(RangeError);
  });
});
