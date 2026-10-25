export type DuoComparison = { matchedCount: number; total: number; message: string };

export function calculateDuoComparison(first: readonly number[], second: readonly number[]): DuoComparison {
  if (first.length !== 3 || second.length !== 3 || [...first, ...second].some((n) => !Number.isInteger(n) || n < 0)) {
    throw new RangeError("Expected three valid choice indexes for each participant.");
  }
  const matchedCount = first.reduce((count, choice, index) => count + Number(choice === second[index]), 0);
  const message = matchedCount === 3
    ? "三道选择都落在同一边，今晚可以从共同兴趣开始。"
    : matchedCount === 0
      ? "三道选择各有方向，正好留出交换想法的空间。"
      : `有 ${matchedCount} 道选择相同，可以从这些共同点聊起。`;
  return { matchedCount, total: 3, message };
}
