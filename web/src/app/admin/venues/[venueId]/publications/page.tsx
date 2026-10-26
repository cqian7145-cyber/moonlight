import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { MerchantHeader, MerchantNotice } from "@/components/merchant/merchant-frame";
import { PublicationControls } from "@/features/merchant/publication-controls";
import { getMerchantAuth } from "@/lib/merchant-auth";
import { requireVenueOwner } from "@/server/venue-auth";

type PageProps = { params: Promise<{ venueId: string }> };

export default function PublicationsPage(props: PageProps) {
  return <Suspense fallback={<MerchantNotice title="活动管理" description="正在验证门店权限…" />}><PublicationsContent {...props} /></Suspense>;
}

async function PublicationsContent({ params }: PageProps) {
  const { venueId } = await params;
  const requestHeaders = await headers();
  const auth = getMerchantAuth();
  if (!auth) return <MerchantNotice title="商家服务暂不可用" description="认证配置或数据库连接暂不可用，请稍后重试。" />;
  let access;
  try { access = await requireVenueOwner(getDb(), auth, requestHeaders, venueId); }
  catch { return <MerchantNotice title="活动暂不可用" description="当前无法连接商家服务，请稍后重试。" />; }
  if (access.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent(`/admin/venues/${venueId}/publications`)}`);
  if (access.kind !== "allowed") return <MerchantNotice title="需要本店 owner 权限" description="只有该门店的 owner 可以上架或下架活动。" />;
  const db = getDb();
  const [templates, publications] = await Promise.all([
    db.select({ id: schema.activityTemplates.id, title: schema.activityTemplates.title, draftContent: schema.activityTemplates.draftContent })
      .from(schema.activityTemplates).where(and(eq(schema.activityTemplates.venueId, venueId), eq(schema.activityTemplates.status, "draft"))),
    db.select({ id: schema.publications.id, status: schema.publications.status, versionNo: schema.activityVersions.versionNo, versionContent: schema.activityVersions.content, activatedAt: schema.publications.activatedAt, deactivatedAt: schema.publications.deactivatedAt })
      .from(schema.publications).innerJoin(schema.activityVersions, eq(schema.activityVersions.id, schema.publications.versionId))
      .where(eq(schema.publications.venueId, venueId)).orderBy(desc(schema.publications.activatedAt)),
  ]);
  const mapped = publications.map((item) => ({ id: item.id, status: item.status, versionNo: item.versionNo,
    title: (item.versionContent as schema.ActivityContent).title ?? "已发布活动", activatedAt: item.activatedAt.toISOString(),
    deactivatedAt: item.deactivatedAt?.toISOString() ?? null }));
  const currentId = mapped.find((item) => item.status === "active")?.id ?? null;
  const draftTemplates = templates.map((template) => ({ ...template, title: template.draftContent?.title ?? template.title }));
  return <main className="merchantPage"><div className="merchantShell"><MerchantHeader role="owner" venueName={access.venue.name} />
    <section className="merchantDashboard"><h1>{access.venue.name}</h1><nav className="merchantManageNav" aria-label="门店运营管理">
      <Link href={`/admin/venues/${venueId}/activities`}>题包</Link><Link aria-current="page" href={`/admin/venues/${venueId}/publications`}>活动上架</Link><Link href={`/admin/venues/${venueId}/tables`}>桌位与二维码</Link>
    </nav><PublicationControls venueId={venueId} templates={draftTemplates} initialCurrentId={currentId} publications={mapped} /></section>
  </div></main>;
}
import { Suspense } from "react";
