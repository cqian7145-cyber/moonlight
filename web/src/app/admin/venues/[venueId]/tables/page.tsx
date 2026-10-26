import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { MerchantHeader, MerchantNotice } from "@/components/merchant/merchant-frame";
import { TableControls } from "@/features/merchant/table-controls";
import { getMerchantAuth } from "@/lib/merchant-auth";
import { requireVenueMember } from "@/server/venue-auth";

type PageProps = { params: Promise<{ venueId: string }> };

export default function TablesPage(props: PageProps) {
  return <Suspense fallback={<MerchantNotice title="桌位管理" description="正在验证门店权限…" />}><TablesContent {...props} /></Suspense>;
}

async function TablesContent({ params }: PageProps) {
  const { venueId } = await params;
  const requestHeaders = await headers();
  const auth = getMerchantAuth();
  if (!auth) return <MerchantNotice title="商家服务暂不可用" description="认证配置或数据库连接暂不可用，请稍后重试。" />;
  let access;
  try { access = await requireVenueMember(getDb(), auth, requestHeaders, venueId); }
  catch { return <MerchantNotice title="桌位暂不可用" description="当前无法连接商家服务，请稍后重试。" />; }
  if (access.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent(`/admin/venues/${venueId}/tables`)}`);
  if (access.kind !== "allowed") return <MerchantNotice title="无权访问该门店" description="当前账号没有这家门店的有效成员关系。" />;
  const rows = await getDb().select({ id: schema.venueTables.id, name: schema.venueTables.name, isEnabled: schema.venueTables.isEnabled, createdAt: schema.venueTables.createdAt })
    .from(schema.venueTables).where(eq(schema.venueTables.venueId, venueId)).orderBy(schema.venueTables.name);
  const tables = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  return <main className="merchantPage"><div className="merchantShell"><MerchantHeader role={access.venue.role} venueName={access.venue.name} />
    <section className="merchantDashboard"><h1>{access.venue.name}</h1>
      {access.venue.role === "owner" && <nav className="merchantManageNav" aria-label="门店运营管理"><Link href={`/admin/venues/${venueId}/activities`}>题包</Link><Link href={`/admin/venues/${venueId}/publications`}>活动上架</Link><Link aria-current="page" href={`/admin/venues/${venueId}/tables`}>桌位与二维码</Link></nav>}
      <TableControls venueId={venueId} initialTables={tables} owner={access.venue.role === "owner"} />
    </section>
  </div></main>;
}
import { Suspense } from "react";
