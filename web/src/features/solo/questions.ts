export type SoloQuestion = {
  prompt: string;
  choices: readonly { label: string; value: 0 | 1 | 2 }[];
};

export const soloQuestions: readonly SoloQuestion[] = [
  {
    prompt: "刚坐下来，你最想先做什么？",
    choices: [
      { label: "找个舒服的位置，慢慢进入状态", value: 0 },
      { label: "看看周围，有没有新鲜的小发现", value: 1 },
      { label: "打开话题，让聊天自然开始", value: 2 },
    ],
  },
  {
    prompt: "如果今晚多出半小时，你更愿意？",
    choices: [
      { label: "不赶时间，把眼前的快乐延长一点", value: 0 },
      { label: "去附近走走，看看没注意过的地方", value: 1 },
      { label: "找个人聊聊最近遇见的有趣事", value: 2 },
    ],
  },
  {
    prompt: "给今晚加一味小彩蛋，你会选？",
    choices: [
      { label: "一段不被打扰的放空时间", value: 0 },
      { label: "试试没尝过的无酒精饮品", value: 1 },
      { label: "一个能让大家笑出来的话题", value: 2 },
    ],
  },
];
