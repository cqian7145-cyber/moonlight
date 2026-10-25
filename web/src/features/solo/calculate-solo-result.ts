export type SoloResult = {
  id: "easygoing" | "curious" | "social";
  title: string;
  description: string;
  suggestion: string;
};

const results: Record<SoloResult["id"], SoloResult> = {
  easygoing: {
    id: "easygoing",
    title: "松弛守门员",
    description: "你会给今晚留一点空白，让好心情慢慢赶上来。",
    suggestion: "挑个舒服的位置，先把这一刻过好。",
  },
  curious: {
    id: "curious",
    title: "新鲜雷达",
    description: "你总能从熟悉的夜晚里，找到一个值得试试的新角度。",
    suggestion: "给今晚留一个小小的第一次。",
  },
  social: {
    id: "social",
    title: "气氛观察员",
    description: "你很会读懂现场的节奏，也知道什么时候让快乐发生。",
    suggestion: "把有趣的话题递给身边的人。",
  },
};

export function calculateSoloResult(answers: readonly number[]): SoloResult {
  if (
    !Array.isArray(answers) ||
    answers.length !== 3 ||
    answers.some((answer) => !Number.isInteger(answer) || answer < 0 || answer > 2)
  ) {
    throw new RangeError("Please provide exactly three answers from 0 to 2.");
  }

  const scores = [0, 0, 0];
  for (const answer of answers) scores[answer] += 1;

  const highestScore = Math.max(...scores);
  const leadingAnswer = answers.find((answer) => scores[answer] === highestScore);
  if (leadingAnswer === undefined) throw new Error("A result could not be calculated.");

  const resultId = ["easygoing", "curious", "social"][leadingAnswer];
  if (!resultId) throw new Error("A result could not be calculated.");

  return { ...results[resultId as SoloResult["id"]] };
}
