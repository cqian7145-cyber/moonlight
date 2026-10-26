"use client";

import Link from "next/link";
import { useRef, useState } from "react";

type Cue = { key: string; prompt: string; choices: readonly string[] };

export function ActivityEditor({ venueId, template }: { venueId: string; template: { id: string; title: string; draftContent: { cues: readonly Cue[] } | null } }) {
  const cues = template.draftContent?.cues ?? [1, 2, 3].map((number) => ({ key: `question-${number}`, prompt: "", choices: ["", "", ""] }));
  const [title, setTitle] = useState(template.title);
  const titleInput = useRef<HTMLInputElement>(null);
  const [questions, setQuestions] = useState(cues.map(({ prompt, choices }) => ({ prompt, choices: [...choices] })));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);

  function updatePrompt(questionIndex: number, prompt: string) {
    setSaved(false);
    setQuestions((current) => current.map((question, index) => index === questionIndex ? { ...question, prompt } : question));
  }

  function updateChoice(questionIndex: number, choiceIndex: number, value: string) {
    setSaved(false);
    setQuestions((current) => current.map((question, index) => index === questionIndex
      ? { ...question, choices: question.choices.map((choice, optionIndex) => optionIndex === choiceIndex ? value : choice) }
      : question));
  }

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/merchant/venues/${venueId}/activities/${template.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: titleInput.current?.value ?? title, cues: questions }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 403 ? "只有本门店 owner 可以保存题包。" : "保存失败，请检查内容后重试。");
      setSaved(true);
      setMessage("草稿已保存。刷新页面后仍可继续编辑。" + (result.template?.draftContent?.cues?.length ? "" : ""));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="merchantManageSection">
      <div className="merchantSectionHeading">
        <div><p className="demoKicker">草稿编辑</p><h2>三道题，每题三个选项</h2></div>
        <Link className="merchantInlineLink" href={`/admin/venues/${venueId}/activities`}>返回题包</Link>
      </div>
      <label className="merchantField">题包名称<input ref={titleInput} maxLength={160} value={title} onChange={(event) => { setTitle(event.target.value); setSaved(false); }} /></label>
      {questions.map((question, questionIndex) => (
        <fieldset className="merchantQuestionEditor" key={questionIndex}>
          <legend>第 {questionIndex + 1} 题</legend>
          <label className="merchantField">题目<input maxLength={180} value={question.prompt} onChange={(event) => updatePrompt(questionIndex, event.target.value)} /></label>
          <div className="merchantChoiceEditor">
            {question.choices.map((choice, choiceIndex) => (
              <label className="merchantField" key={choiceIndex}>选项 {choiceIndex + 1}<input maxLength={80} value={choice} onChange={(event) => updateChoice(questionIndex, choiceIndex, event.target.value)} /></label>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="merchantFormHint">内容仅支持纯文本。每个问题的技术标识由系统生成并在编辑中保持稳定。</p>
      {message && <p className={saved ? "merchantFormMessage merchantSuccess" : "merchantFormMessage"} role={saved ? "status" : "alert"}>{message}</p>}
      <button className="merchantActionButton" type="button" disabled={busy} onClick={save}>{busy ? "正在保存…" : "保存草稿"}</button>
    </section>
  );
}
