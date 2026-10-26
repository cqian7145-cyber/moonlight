import { Suspense } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getMerchantAuth } from "@/lib/merchant-auth";
import { MerchantHeader, MerchantNotice } from "@/components/merchant/merchant-frame";
import { listVenueMemberships } from "@/server/venue-auth";

type StaffPageProps = { searchParams: Promise<{ venueId?: string }> };

export default function StaffPage(props: StaffPageProps) {
  return <Suspense fallback={<MerchantNotice title="门店工作台" description="正在验证门店访问权限…" />}><StaffContent {...props} /></Suspense>;
}

async function StaffContent({ searchParams }: StaffPageProps) {
  const requestHeaders = await headers();
  const auth = getMerchantAuth();
  if (!auth) return <MerchantNotice title="商家服务暂不可用" description="认证配置或数据库连接暂不可用，请稍后重试。" />;

  let access;
  try {
    access = await listVenueMemberships(getDb(), auth, requestHeaders);
  } catch {
    return <MerchantNotice title="门店信息暂不可用" description="当前无法连接商家服务，请稍后重试。" />;
  }
  if (access.kind === "unauthenticated") redirect("/login?next=%2Fstaff");
  if (access.venues.length === 0) {
    return <MerchantNotice title="当前账号没有门店权限" description="商家账号需要由门店负责人或 Moonlight 受控开通。" />;
  }

  const params = await searchParams;
  const selected = params.venueId
    ? access.venues.find((venue) => venue.id === params.venueId)
    : access.venues.length === 1 ? access.venues[0] : undefined;
  if (params.venueId && !selected) {
    return <MerchantNotice title="无权访问该门店" description="请从当前账号有权限的门店中选择。" />;
  }
  if (!selected) {
    return (
      <main className="merchantPage">
        <div className="merchantShell">
          <MerchantHeader />
          <section className="merchantNotice" aria-labelledby="venue-select-title">
            <p className="demoKicker">商家工作台</p>
            <h1 id="venue-select-title">选择门店</h1>
            <p>只显示当前账号已获授权的门店。</p>
            <ul className="merchantVenueList">
              {access.venues.map((venue) => (
                <li key={venue.id}>
                  <Link href={`/staff?venueId=${encodeURIComponent(venue.id)}`}>
                    <span>{venue.name}</span><span>{venue.role === "owner" ? "店主" : "店员"} · {venue.status === "active" ? "营业中" : venue.status === "suspended" ? "已暂停" : "已归档"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    );
  }

  let currentActivity: { title: string; versionNo: number; questionCount: number } | null = null;
  let tableRows: { id: string; name: string; isEnabled: boolean }[] = [];
  try {
    const db = getDb();
    const [active] = await db.select({ versionNo: schema.activityVersions.versionNo, content: schema.activityVersions.content, templateTitle: schema.activityTemplates.title })
      .from(schema.publications).innerJoin(schema.activityVersions, eq(schema.activityVersions.id, schema.publications.versionId))
      .innerJoin(schema.activityTemplates, eq(schema.activityTemplates.id, schema.activityVersions.templateId))
      .where(and(eq(schema.publications.venueId, selected.id), eq(schema.publications.status, "active"))).limit(1);
    if (active) {
      const content = active.content as schema.ActivityContent;
      currentActivity = { title: content.title ?? active.templateTitle, versionNo: active.versionNo, questionCount: content.cues.length };
    }
    tableRows = await db.select({ id: schema.venueTables.id, name: schema.venueTables.name, isEnabled: schema.venueTables.isEnabled })
      .from(schema.venueTables).where(eq(schema.venueTables.venueId, selected.id)).orderBy(schema.venueTables.name);
  } catch {
    return <MerchantNotice title="门店信息暂不可用" description="当前无法连接商家服务，请稍后重试。" />;
  }

  return (
    <main className="merchantPage">
      <div className="merchantShell">
        <MerchantHeader role={selected.role} venueName={selected.name} />
        <section className="merchantDashboard" aria-labelledby="staff-title">
          <p className="demoKicker">门店工作台</p>
          <h1 id="staff-title">{selected.name}</h1>
          <p className="merchantRoleLine">当前角色：{selected.role === "owner" ? "店主（owner）" : "店员（staff）"}</p>
          <p>门店状态：{selected.status === "active" ? "营业中" : selected.status === "suspended" ? "已暂停" : "已归档"}</p>
          <section className="merchantReadOnlySummary" aria-labelledby="staff-current-activity">
            <p className="demoKicker">只读概要</p><h2 id="staff-current-activity">当前活动</h2>
            {currentActivity ? <p><strong>{currentActivity.title} · v{currentActivity.versionNo}</strong> · {currentActivity.questionCount} 道题正在使用</p> : <p>当前没有上架活动。</p>}
            <h3>桌位状态</h3>
            {tableRows.length ? <ul className="merchantManageList">{tableRows.map((table) => <li key={table.id}><strong>{table.name}</strong><span>{table.isEnabled ? "已启用" : "已停用"}</span></li>)}</ul> : <p>当前没有桌位。</p>}
            <p className="merchantFormHint">店员账号仅可查看活动和桌位概要，不会显示桌码，也不能保存、发布、上下架或轮换桌码。</p>
          </section>
          {selected.role === "owner" && <Link className="merchantInlineLink" href={`/admin?venueId=${encodeURIComponent(selected.id)}`}>进入店主管理首页</Link>}
          <Link className="merchantInlineLink" href={selected.role === "owner" ? `/admin/venues/${selected.id}/tables` : "/staff"}>
            {selected.role === "owner" ? "管理桌位与二维码" : "返回门店列表"}
          </Link>
        </section>
      </div>
    </main>
  );
}
