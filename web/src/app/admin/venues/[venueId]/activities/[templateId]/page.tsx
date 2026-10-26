import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { MerchantHeader, MerchantNotice } from "@/components/merchant/merchant-frame";
import { ActivityEditor } from "@/features/merchant/activity-editor";
import { getMerchantAuth } from "@/lib/merchant-auth";
import { requireVenueOwner } from "@/server/venue-auth";

type PageProps = { params: Promise<{ venueId: string; templateId: string }> };

export default function ActivityEditPage(props: PageProps) {
  return <Suspense fallback={<MerchantNotice title="题包编辑" description="正在验证门店权限…" />}><ActivityEditContent {...props} /></Suspense>;
}

async function ActivityEditContent({ params }: PageProps) {
  const { venueId, templateId } = await params;
  const requestHeaders = await headers();
  const auth = getMerchantAuth();
  if (!auth) return <MerchantNotice title="商家服务暂不可用" description="认证配置或数据库连接暂不可用，请稍后重试。" />;
  let access;
  try { access = await requireVenueOwner(getDb(), auth, requestHeaders, venueId); }
  catch { return <MerchantNotice title="题包暂不可用" description="当前无法连接商家服务，请稍后重试。" />; }
  if (access.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent(`/admin/venues/${venueId}/activities/${templateId}`)}`);
  if (access.kind !== "allowed") return <MerchantNotice title="需要本店 owner 权限" description="只有该门店的 owner 可以编辑题包。" />;
  const [template] = await getDb().select({ id: schema.activityTemplates.id, title: schema.activityTemplates.title, status: schema.activityTemplates.status, draftContent: schema.activityTemplates.draftContent })
    .from(schema.activityTemplates).where(and(eq(schema.activityTemplates.id, templateId), eq(schema.activityTemplates.venueId, venueId))).limit(1);
  if (!template || template.status === "archived") return <MerchantNotice title="找不到这个草稿" description="草稿不存在、已归档，或不属于当前门店。" />;
  return <main className="merchantPage"><div className="merchantShell"><MerchantHeader role="owner" venueName={access.venue.name} /><section className="merchantDashboard">
    <h1>{access.venue.name}</h1><ActivityEditor venueId={venueId} template={{ ...template, title: template.draftContent?.title ?? template.title }} />
  </section></div></main>;
}
import { Suspense } from "react";
