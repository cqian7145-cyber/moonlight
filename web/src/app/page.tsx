import Link from "next/link";

export default function Home() {
  return (
    <main className="homePage">
      <a className="skipLink" href="#main-content">跳到主要内容</a>
      <header className="siteHeader">
        <Link className="wordmark" href="/" aria-label="Moonlight 首页">
          moonlight<span className="wordmarkDot" aria-hidden="true" />
        </Link>
        <span className="headerNote">酒馆里的轻松小互动</span>
      </header>

      <section className="homeHero" id="main-content" aria-labelledby="home-title">
        <div className="heroCopy">
          <p className="eyebrow"><span className="statusDot" /> 扫码即玩 · 个人模式先行</p>
          <h1 id="home-title">扫码，<br />就玩起来。</h1>
          <p className="heroDescription">
            在酒馆坐下，扫一下桌上的二维码。用手机做几个小选择，给今晚添一点新鲜感。
          </p>
          <div className="heroActions">
            <Link className="button buttonPrimary" href="/play/demo">
              自己玩
              <span className="buttonArrow" aria-hidden="true">↗</span>
            </Link>
            <button className="button buttonQuiet" type="button" disabled aria-describedby="friends-note">
              与朋友玩
              <span className="comingSoon">开发中</span>
            </button>
          </div>
          <p className="heroFootnote" id="friends-note">
            个人玩法是当前可用演示；朋友同玩还没有开放。
          </p>
        </div>

        <aside className="playTicket" aria-label="个人玩法说明">
          <div className="ticketTopline">
            <span>今晚的小签</span>
            <span className="ticketSeal" aria-hidden="true">MOON<br />LIGHT</span>
          </div>
          <div className="ticketMain">
            <p className="ticketLabel">给此刻一点新鲜感</p>
            <p className="ticketHeadline">三道小选择，<br />一份今晚灵感。</p>
          </div>
          <div className="ticketSteps" aria-label="玩法步骤">
            <span><b>01</b> 选一个</span>
            <span><b>02</b> 再选两个</span>
            <span><b>03</b> 看今晚小签</span>
          </div>
          <div className="ticketPerforation" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
          <div className="ticketBottom">
            <span>只是一轮轻松演示，不是性格测试</span>
            <span className="ticketSpark" aria-hidden="true">✳</span>
          </div>
        </aside>
      </section>

      <footer className="homeFooter">
        <span>答案只在当前页面生成，不会保存或发送。</span>
        <span>Moonlight V1 · 本地演示</span>
      </footer>
    </main>
  );
}
