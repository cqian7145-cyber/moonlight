import { Suspense } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getMerchantAuth } from "@/lib/merchant-auth";
import { MerchantHeader, MerchantNotice } from "@/components/merchant/merchant-frame";
import { listVenueMemberships } from "@/server/venue-auth";

type AdminPageProps = { searchParams: Promise<{ venueId?: string }> };

export default function AdminPage(props: AdminPageProps) {
  return <Suspense fallback={<MerchantNotice title="店主管理" description="正在验证店主权限…" />}><AdminContent {...props} /></Suspense>;
}

async function AdminContent({ searchParams }: AdminPageProps) {
  const requestHeaders = await headers();
  const auth = getMerchantAuth();
  if (!auth) return <MerchantNotice title="商家服务暂不可用" description="认证配置或数据库连接暂不可用，请稍后重试。" />;

  let access;
  try {
    access = await listVenueMemberships(getDb(), auth, requestHeaders);
  } catch {
    return <MerchantNotice title="门店信息暂不可用" description="当前无法连接商家服务，请稍后重试。" />;
  }
  if (access.kind === "unauthenticated") redirect("/login?next=%2Fadmin");
  const ownerVenues = access.venues.filter((venue) => venue.role === "owner");
  if (ownerVenues.length === 0) {
    return <MerchantNotice title="需要店主权限" description={access.venues.length ? "当前账号是店员，不能访问店主管理入口。" : "当前账号没有任何有效门店权限。"} />;
  }

  const params = await searchParams;
  const selected = params.venueId
    ? ownerVenues.find((venue) => venue.id === params.venueId)
    : ownerVenues.length === 1 ? ownerVenues[0] : undefined;
  if (params.venueId && !selected) {
    return <MerchantNotice title="无权访问该门店管理页" description="只有该门店的 owner 可以访问店主管理入口。" />;
  }
  if (!selected) {
    return (
      <main className="merchantPage">
        <div className="merchantShell">
          <MerchantHeader />
          <section className="merchantNotice" aria-labelledby="owner-venue-select-title">
            <p className="demoKicker">店主管理</p>
            <h1 id="owner-venue-select-title">选择管理门店</h1>
            <p>只列出当前账号拥有 owner 权限的门店。</p>
            <ul className="merchantVenueList">
              {ownerVenues.map((venue) => (
                <li key={venue.id}>
                  <Link href={`/admin?venueId=${encodeURIComponent(venue.id)}`}>
                    <span>{venue.name}</span><span>{venue.status === "active" ? "营业中" : venue.status === "suspended" ? "已暂停" : "已归档"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="merchantPage">
      <div className="merchantShell">
        <MerchantHeader role="owner" venueName={selected.name} />
        <section className="merchantDashboard" aria-labelledby="admin-title">
          <p className="demoKicker">店主管理</p>
          <h1 id="admin-title">{selected.name}</h1>
          <p className="merchantRoleLine">当前角色：店主（owner）</p>
          <p>门店状态：{selected.status === "active" ? "营业中" : selected.status === "suspended" ? "已暂停" : "已归档"}</p>
          <nav className="merchantManageNav" aria-label="门店运营管理">
            <Link href={`/admin/venues/${selected.id}/activities`}>题包管理</Link>
            <Link href={`/admin/venues/${selected.id}/publications`}>活动上架与下架</Link>
            <Link href={`/admin/venues/${selected.id}/tables`}>桌位与二维码</Link>
            <Link href={`/admin/venues/${selected.id}/analytics?period=7d`}>经营复盘</Link>
          </nav>
          <Link className="merchantInlineLink" href={`/staff?venueId=${encodeURIComponent(selected.id)}`}>返回门店工作台</Link>
        </section>
      </div>
    </main>
  );
}
