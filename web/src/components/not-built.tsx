import Link from "next/link";

type NotBuiltProps = { title: string; description: string };

export function NotBuilt({ title, description }: NotBuiltProps) {
  return (
    <main className="quietPage">
      <div className="quietShell">
        <header className="quietHeader">
          <Link className="backLink" href="/">返回首页</Link>
          <Link className="demoBrand" href="/" aria-label="Moonlight 首页">moonlight<span>.</span></Link>
        </header>
        <section className="quietContent" aria-labelledby="not-built-title">
          <span className="quietIcon" aria-hidden="true">—</span>
          <p className="demoKicker">Moonlight V1</p>
          <h1 id="not-built-title">{title}</h1>
          <p>{description}</p>
          <Link className="button buttonPrimary" href="/">回到首页</Link>
        </section>
      </div>
    </main>
  );
}
