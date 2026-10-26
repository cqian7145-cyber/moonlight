import Link from "next/link";
import { MerchantLogoutButton } from "@/features/merchant/merchant-controls";

export function MerchantHeader({ role, venueName }: { role?: "owner" | "staff"; venueName?: string }) {
  return (
    <header className="merchantHeader">
      <Link className="demoBrand" href="/" aria-label="Moonlight 首页">moonlight<span>.</span></Link>
      <div className="merchantHeaderRight">
        {venueName ? <span className="merchantVenueLabel">{venueName}{role ? ` · ${role === "owner" ? "店主" : "店员"}` : ""}</span> : null}
        <MerchantLogoutButton />
      </div>
    </header>
  );
}

export function MerchantNotice({ title, description, children }: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="merchantPage">
      <div className="merchantShell">
        <MerchantHeader />
        <section className="merchantNotice" aria-labelledby="merchant-notice-title">
          <p className="demoKicker">商家工作台</p>
          <h1 id="merchant-notice-title">{title}</h1>
          <p>{description}</p>
          {children}
        </section>
      </div>
    </main>
  );
}
