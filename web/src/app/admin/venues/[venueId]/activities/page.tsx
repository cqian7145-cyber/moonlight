import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { MerchantHeader, MerchantNotice } from "@/components/merchant/merchant-frame";
import { ActivityListControls } from "@/features/merchant/activity-list-controls";
import { getMerchantAuth } from "@/lib/merchant-auth";
import { requireVenueOwner } from "@/server/venue-auth";

type PageProps = { params: Promise<{ venueId: string }> };

export default function ActivitiesPage(props: PageProps) {
  return <Suspense fallback={<MerchantNotice title="题包管理" description="正在验证门店权限…" />}><ActivitiesContent {...props} /></Suspense>;
}

async function ActivitiesContent({ params }: PageProps) {
  const { venueId } = await params;
  const requestHeaders = await headers();
  const auth = getMerchantAuth();
  if (!auth) return <MerchantNotice title="商家服务暂不可用" description="认证配置或数据库连接暂不可用，请稍后重试。" />;
  let access;
  try { access = await requireVenueOwner(getDb(), auth, requestHeaders, venueId); }
  catch { return <MerchantNotice title="题包暂不可用" description="当前无法连接商家服务，请稍后重试。" />; }
  if (access.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent(`/admin/venues/${venueId}/activities`)}`);
  if (access.kind !== "allowed") return <MerchantNotice title="需要本店 owner 权限" description="只有该门店的 owner 可以创建和编辑题包。" />;

  const db = getDb();
  const [rows, versions, active] = await Promise.all([
    db.select().from(schema.activityTemplates).where(eq(schema.activityTemplates.venueId, venueId)).orderBy(desc(schema.activityTemplates.updatedAt)),
    db.select({ id: schema.activityVersions.id, templateId: schema.activityVersions.templateId, versionNo: schema.activityVersions.versionNo, content: schema.activityVersions.content })
      .from(schema.activityVersions).where(eq(schema.activityVersions.venueId, venueId)).orderBy(desc(schema.activityVersions.versionNo)),
    db.select({ versionId: schema.publications.versionId }).from(schema.publications).where(and(eq(schema.publications.venueId, venueId), eq(schema.publications.status, "active"))).limit(1),
  ]);
  const activeVersionId = active[0]?.versionId;
  const templates = rows.map((template) => ({
    id: template.id, title: template.draftContent?.title ?? template.title, status: template.status, updatedAt: template.updatedAt.toISOString(),
    draftContent: template.draftContent,
    versions: versions.filter((version) => version.templateId === template.id).map((version) => ({
      id: version.id, versionNo: version.versionNo, title: (version.content as schema.ActivityContent).title ?? template.title,
      active: version.id === activeVersionId,
    })),
  }));

  return <main className="merchantPage"><div className="merchantShell">
    <MerchantHeader role="owner" venueName={access.venue.name} />
    <section className="merchantDashboard"><p className="demoKicker">店主管理</p><h1>{access.venue.name}</h1>
      <nav className="merchantManageNav" aria-label="门店运营管理">
        <Link aria-current="page" href={`/admin/venues/${venueId}/activities`}>题包</Link>
        <Link href={`/admin/venues/${venueId}/publications`}>活动上架</Link>
        <Link href={`/admin/venues/${venueId}/tables`}>桌位与二维码</Link>
      </nav>
      <ActivityListControls venueId={venueId} templates={templates} />
    </section>
  </div></main>;
}
import { Suspense } from "react";
