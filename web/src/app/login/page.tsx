import { Suspense } from "react";
import Link from "next/link";
import { MerchantLoginForm } from "@/features/merchant/merchant-controls";
import { MerchantNotice } from "@/components/merchant/merchant-frame";

type LoginPageProps = { searchParams: Promise<{ next?: string; loggedOut?: string }> };

function safeReturnPath(value: string | undefined) {
  if (value === "/admin" || value === "/staff") return value;
  if (value && /^\/(admin|staff)\?venueId=[0-9a-f-]{36}$/i.test(value)) return value;
  return "/staff";
}

export default function LoginPage(props: LoginPageProps) {
  return <Suspense fallback={<MerchantNotice title="商家登录" description="正在加载登录表单…" />}><LoginContent {...props} /></Suspense>;
}

async function LoginContent({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  return (
    <main className="merchantPage">
      <div className="merchantShell">
        <header className="merchantHeader">
          <Link className="demoBrand" href="/" aria-label="Moonlight 首页">moonlight<span>.</span></Link>
          <Link className="merchantTextButton" href="/">返回顾客首页</Link>
        </header>
        <section className="merchantLoginCard" aria-labelledby="merchant-login-title">
          <p className="demoKicker">Moonlight V1 · 商家端</p>
          <h1 id="merchant-login-title">商家登录</h1>
          <p>使用已开通的商家账号进入门店工作台。</p>
          {params.loggedOut === "1" ? <p className="merchantSuccess" role="status">你已安全退出。</p> : null}
          <MerchantLoginForm returnTo={safeReturnPath(params.next)} />
        </section>
      </div>
    </main>
  );
}
