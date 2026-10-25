import Link from "next/link";
import type { PublicTableEntry } from "@/server/customer-entry";

function Wordmark() {
  return <Link className="entryWordmark" href="/" aria-label="Moonlight 首页">moonlight<span aria-hidden="true" /></Link>;
}

function EntryFrame({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="entryPage">
      <div className="entryShell">
        <header className="entryHeader">
          <Wordmark />
          <span className="entryHeaderNote">桌边轻互动</span>
        </header>
        {children}
        <footer className="entryFooter">
          桌码用于识别门店与桌位，不代表参与者身份或到店证明。
        </footer>
      </div>
    </main>
  );
}

function EntryMessage({ title, description }: { title: string; description: string }) {
  return (
    <EntryFrame>
      <section className="entryMessage" aria-labelledby="entry-message-title">
        <span className="entryStatusMark" aria-hidden="true" />
        <p className="entryEyebrow">MOONLIGHT · 桌边互动</p>
        <h1 id="entry-message-title">{title}</h1>
        <p className="entryDescription">{description}</p>
        <Link className="entrySecondaryLink" href="/">回到首页</Link>
      </section>
    </EntryFrame>
  );
}

export function TableEntryView({ entry }: { entry: PublicTableEntry }) {
  if (entry.status === "not_found") {
    return <EntryMessage title="没有找到这张桌码" description="请检查桌上的二维码是否完整，或向店员确认入口。" />;
  }
  if (entry.status === "table_paused") {
    return <EntryMessage title="这张桌码暂不可用" description="请稍后再试，或向店员确认当前桌位。" />;
  }
  if (entry.status === "venue_paused") {
    return <EntryMessage title="门店互动暂未开放" description="这家门店目前暂不提供桌边互动。" />;
  }
  if (entry.status === "no_activity") {
    return <EntryMessage title="今晚还没有上架玩法" description="门店暂时没有可参与的小玩法，可以稍后再来看看。" />;
  }
  if (entry.status === "unavailable") {
    return <EntryMessage title="现在暂时无法载入" description="请稍等片刻再试。当前请求不会创建或保存参与记录。" />;
  }

  return (
    <EntryFrame>
      <section className="entryContent" aria-labelledby="entry-title">
        <p className="entryEyebrow"><span className="entryLiveDot" aria-hidden="true" /> 桌边轻互动</p>
        <p className="entryVenue">欢迎来到 <strong>{entry.venueName}</strong></p>
        <h1 id="entry-title">给今晚一点新鲜感。</h1>
        <p className="entryDescription">做几个轻松的小选择，为今晚挑一份灵感。</p>

        <section className="entryActivity" aria-labelledby="activity-title">
          <div className="entryActivityMeta">
            <span>本桌当前玩法</span>
            <span>{entry.questionCount} 个小选择</span>
          </div>
          <h2 id="activity-title">{entry.activityTitle}</h2>
        </section>

        <div className="entryActions">
          <div className="entryPrimaryGroup">
            <Link className="entryPrimaryButton" href="/play/demo">先体验个人玩法</Link>
            <p>演示，不会保存记录。</p>
          </div>
          <div className="entryDuoGroup">
            <button className="entryDuoButton" type="button" disabled>
              <span>双人默契</span><span className="entryComingSoon">后续版本开放</span>
            </button>
          </div>
        </div>
        <p className="entryPrivacy">本次入口只读取门店上架信息；还没有开始正式答题或保存个人答案。</p>
      </section>
    </EntryFrame>
  );
}

export function EntryLoading() {
  return (
    <EntryFrame>
      <section className="entryMessage entryLoading" aria-busy="true" aria-live="polite">
        <span className="entryStatusMark" aria-hidden="true" />
        <p className="entryEyebrow">正在读取本桌玩法</p>
        <h1>稍等一下</h1>
        <p className="entryDescription">正在确认门店当前上架的信息。</p>
      </section>
    </EntryFrame>
  );
}
