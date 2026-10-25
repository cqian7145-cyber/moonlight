"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Question = { cueKey: string; prompt: string; choices: string[] };
type QuestionsResponse = {
  status: "in_progress" | "completed";
  attempt: { status: "in_progress" | "completed"; answeredCount: number };
  activity: { title: string };
  questions: Question[];
  submissions: { cueKey: string; optionIndex: number; createdAt: string }[];
};
type SoloResult = { id: string; title: string; description: string; suggestion: string };
type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "playing"; data: QuestionsResponse; selectedIndex: number | null; submitting: boolean; message?: string }
  | { kind: "result"; result: SoloResult };

function errorMessage(status: number, error: string | undefined): string {
  if (status === 401) return "没有找到本设备的参与会话。请回到桌码入口重新开始。";
  if (status === 404) return "没有找到这张桌码，请重新扫描桌上的二维码。";
  if (status === 409 && error === "attempt_closed") return "这次参与已结束，不能继续提交答案。";
  if (status === 409 && error === "result_not_ready") return "三道题完成后才会生成结果。";
  if (status === 409) return "门店或本桌当前暂不可用，请稍后重试。";
  if (status === 503) return "暂时无法连接服务，答案没有得到保存确认，请重试。";
  return "暂时无法读取本次参与，请稍后重试。";
}

async function parseError(response: Response): Promise<string> {
  let error: string | undefined;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string") error = payload.error;
  } catch {
    // Keep the public message generic if a response isn't valid JSON.
  }
  return errorMessage(response.status, error);
}

async function loadSoloScreen(tableCode: string): Promise<Exclude<Screen, { kind: "loading" } | { kind: "error" }>> {
  const response = await fetch(`/api/attempts/questions?tableCode=${encodeURIComponent(tableCode)}`, {
    method: "GET", credentials: "same-origin", cache: "no-store",
  });
  if (!response.ok) throw new Error(await parseError(response));
  const data = await response.json() as QuestionsResponse;
  if (data.status === "completed") {
    const resultResponse = await fetch(`/api/attempts/result?tableCode=${encodeURIComponent(tableCode)}`, {
      method: "GET", credentials: "same-origin", cache: "no-store",
    });
    if (!resultResponse.ok) throw new Error(await parseError(resultResponse));
    const payload = await resultResponse.json() as { result: SoloResult };
    return { kind: "result", result: payload.result };
  }
  return { kind: "playing", data, selectedIndex: null, submitting: false };
}

export function SoloPlay({ tableCode }: { tableCode: string }) {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    loadSoloScreen(tableCode).then((next) => {
      if (active) setScreen(next);
    }).catch((error: unknown) => {
      if (active) setScreen({ kind: "error", message: error instanceof Error ? error.message : "暂时无法读取本次参与。" });
    });
    return () => { active = false; };
  }, [tableCode]);

  async function retry() {
    setScreen({ kind: "loading" });
    try {
      setScreen(await loadSoloScreen(tableCode));
    } catch (error) {
      setScreen({ kind: "error", message: error instanceof Error ? error.message : "暂时无法读取本次参与。" });
    }
  }

  async function submit() {
    if (screen.kind !== "playing" || screen.selectedIndex === null || screen.submitting) return;
    const unansweredIndex = screen.data.questions.findIndex((question) =>
      !screen.data.submissions.some((submission) => submission.cueKey === question.cueKey));
    const question = screen.data.questions[unansweredIndex];
    if (!question) return;
    setScreen({ ...screen, submitting: true, message: undefined });
    try {
      const response = await fetch("/api/attempts/answer", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tableCode, cueKey: question.cueKey, optionIndex: screen.selectedIndex }),
      });
      if (!response.ok) throw new Error(await parseError(response));
      setScreen(await loadSoloScreen(tableCode));
    } catch (error) {
      setScreen({
        ...screen,
        submitting: false,
        message: error instanceof Error ? error.message : "提交没有得到确认，请重试。",
      });
    }
  }

  const deskHref = `/t/${encodeURIComponent(tableCode)}`;

  if (screen.kind === "loading") {
    return <main className="soloPlayShell"><section className="soloPlayMessage" role="status" aria-live="polite">
      <p className="demoKicker">MOONLIGHT · 个人玩法</p><h1>正在恢复你的进度</h1><p>正在从服务端读取本次参与。</p>
    </section></main>;
  }

  if (screen.kind === "error") {
    return <main className="soloPlayShell"><section className="soloPlayMessage" aria-labelledby="solo-error-title">
      <p className="demoKicker">MOONLIGHT · 个人玩法</p><h1 id="solo-error-title">暂时无法继续</h1>
      <p role="alert">{screen.message}</p>
      <div className="resultActions"><button className="button buttonPrimary" type="button" onClick={retry}>重新读取</button>
        <Link className="button buttonQuiet" href={deskHref}>回到桌码入口</Link></div>
    </section></main>;
  }

  if (screen.kind === "result") {
    return <main className="soloPlayShell"><article className="resultCard soloResultCard">
      <div className="resultTop"><p className="resultLabel">本次个人结果</p><span className="resultMark" aria-hidden="true" /></div>
      <p className="demoKicker">三道选择，留下一点今晚的灵感</p>
      <h1>{screen.result.title}</h1>
      <p className="resultDescription">{screen.result.description}</p>
      <div className="suggestionBox"><span>给今晚的小建议</span><p>{screen.result.suggestion}</p></div>
      <p className="resultDisclaimer">这是根据本次选择生成的轻松趣味结果，不是心理测量或诊断。</p>
      <div className="resultActions"><Link className="button buttonPrimary" href={deskHref}>回到桌码入口</Link></div>
    </article></main>;
  }

  const answered = screen.data.submissions.length;
  const currentIndex = screen.data.questions.findIndex((question) =>
    !screen.data.submissions.some((submission) => submission.cueKey === question.cueKey));
  const question = screen.data.questions[currentIndex];
  if (!question) {
    return <main className="soloPlayShell"><section className="soloPlayMessage">
      <p role="alert">进度信息暂时不完整，请重新读取服务端记录。</p>
      <button className="button buttonPrimary" type="button" onClick={retry}>重新读取</button>
    </section></main>;
  }

  return <main className="soloPlayShell">
    <header className="soloPlayHeader"><Link className="demoBrand" href="/">moonlight<span>.</span></Link>
      <Link className="backLink" href={deskHref}>退出答题</Link></header>
    <section className="demoIntro soloIntro"><p className="demoKicker">{screen.data.activity.title}</p>
      <h1>给今晚一点新鲜感</h1><p>每个选择都会即时保存，回来时可以接着完成。</p></section>
    <article className="questionCard">
      <div className="progressHead"><span>个人小选择</span><strong>第 {currentIndex + 1} / 3 题</strong></div>
      <div className="progressTrack" role="progressbar" aria-label="答题进度" aria-valuemin={0} aria-valuemax={3} aria-valuenow={answered}>
        <div className="progressValue" style={{ width: `${answered / 3 * 100}%` }} />
      </div>
      <form className="questionForm" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset disabled={screen.submitting}>
          <legend>{question.prompt}</legend>
          <div className="choiceList">
            {question.choices.map((choice, index) => <label className="choiceOption" key={`${question.cueKey}-${index}`}>
              <input type="radio" name="solo-answer" value={index} checked={screen.selectedIndex === index}
                onChange={() => setScreen({ ...screen, selectedIndex: index, message: undefined })} />
              <span className="choiceMark" aria-hidden="true" /><span className="choiceText">{choice}</span>
            </label>)}
          </div>
        </fieldset>
        <div className="questionActions">
          <p className="selectionHint" aria-live="polite">{screen.message ?? (screen.submitting ? "正在保存你的选择…" : "选择一个最贴近此刻的答案。")}</p>
          <button className="continueButton" type="submit" disabled={screen.selectedIndex === null || screen.submitting}>
            {screen.submitting ? "正在保存…" : currentIndex === 2 ? "提交并查看结果" : "保存并继续"}
          </button>
        </div>
        {screen.message && <p className="soloAnswerError" role="alert">{screen.message}</p>}
      </form>
      <p className="demoPrivacy">答案只用于生成本次个人趣味结果。</p>
    </article>
  </main>;
}
