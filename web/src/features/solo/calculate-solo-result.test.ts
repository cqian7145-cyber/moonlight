import { describe, expect, it } from "vitest";
import { calculateSoloResult } from "./calculate-solo-result";

describe("calculateSoloResult", () => {
  it("returns a calm result when relaxed choices are most common", () => {
    expect(calculateSoloResult([0, 0, 2]).id).toBe("easygoing");
  });

  it("returns a curious result when discovery choices are most common", () => {
    expect(calculateSoloResult([1, 1, 0]).id).toBe("curious");
  });

  it("returns a social result when connection choices are most common", () => {
    expect(calculateSoloResult([2, 2, 1]).id).toBe("social");
  });

  it("breaks a three-way tie using the first answer", () => {
    expect(calculateSoloResult([2, 0, 1]).id).toBe("social");
  });

  it.each([
    { answers: [] as number[] },
    { answers: [0, 1] },
    { answers: [0, 1, 3] },
    { answers: [0, 1, 1.5] },
  ])("rejects an invalid answer set: $answers", ({ answers }) => {
    expect(() => calculateSoloResult(answers)).toThrow(RangeError);
  });
});
