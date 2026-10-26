import { Suspense } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { MerchantHeader, MerchantNotice } from "@/components/merchant/merchant-frame";
import { getDb } from "@/db";
import { getMerchantAuth } from "@/lib/merchant-auth";
import { requireVenueMember } from "@/server/venue-auth";
import { getVenueAnalytics } from "@/server/venue-analytics";

type Props = { params: Promise<{ venueId: string }>; searchParams: Promise<{ period?: string }> };
export default function AnalyticsPage(props: Props) {
  return <Suspense fallback={<MerchantNotice title="经营复盘" description="正在验证门店权限并读取统计…" />}><AnalyticsContent {...props} /></Suspense>;
}

async function AnalyticsContent({ params, searchParams }: Props) {
  const { venueId } = await params;
  const query = await searchParams;
  const days = query.period === "30d" ? 30 : 7;
  const requestHeaders = await headers();
  const auth = getMerchantAuth();
  if (!auth) return <MerchantNotice title="商家服务暂不可用" description="认证或数据库连接暂不可用，请稍后重试。" />;
  let access;
  try { access = await requireVenueMember(getDb() as never, auth, requestHeaders, venueId); }
  catch { return <MerchantNotice title="经营复盘暂不可用" description="当前无法连接商家服务，请稍后重试。" />; }
  if (access.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent(`/admin/venues/${venueId}/analytics`)}`);
  if (access.kind !== "allowed") return <MerchantNotice title="无权访问该门店" description="当前账号没有这家门店的有效成员关系。" />;
  let data;
  try { data = await getVenueAnalytics(getDb() as never, venueId, { days }); }
  catch { return <MerchantNotice title="经营复盘暂不可用" description="统计暂时无法读取，请稍后重试。" />; }
  const { summary, period, versions } = data;
  const ratingValues = [1, 2, 3, 4, 5] as const;
  return <main className="merchantPage"><div className="merchantShell"><MerchantHeader role={access.venue.role} venueName={access.venue.name} />
    <section className="merchantDashboard analyticsDashboard"><div className="analyticsTitle"><div><p className="merchantEyebrow">门店经营</p><h1>经营复盘</h1><p>{period.start.slice(0, 10)} 至 {period.end.slice(0, 10)} · {period.timezone} · 更新于 {new Date(period.refreshedAt).toLocaleString("zh-CN", { timeZone: period.timezone })}</p></div>
      <nav className="analyticsPeriods" aria-label="统计周期"><Link aria-current={days === 7 ? "page" : undefined} href={`?period=7d`}>过去 7 天</Link><Link aria-current={days === 30 ? "page" : undefined} href={`?period=30d`}>过去 30 天</Link></nav></div>
      <nav className="merchantManageNav" aria-label="门店运营管理"><Link href={`/admin/venues/${venueId}/activities`}>题包</Link><Link href={`/admin/venues/${venueId}/publications`}>活动上架</Link><Link href={`/admin/venues/${venueId}/tables`}>桌位与二维码</Link><Link aria-current="page" href={`/admin/venues/${venueId}/analytics?period=${days}d`}>经营复盘</Link></nav>
      <p className="analyticsDefinition">参与次数按开始时间统计 Attempt；每位双人参与者各计一次，因此一个完整双人房间是两次参与。它不代表扫码人数、到店人数或独立顾客数。</p>
      {summary.attemptStarted === 0 ? <section className="analyticsEmpty"><h2>这个周期还没有参与记录</h2><p>当前没有可计算的参与或完成率。没有记录的指标显示为 0 或 —。</p></section> : <>
        <div className="analyticsKpis"><article><span>参与次数</span><strong>{summary.attemptStarted}</strong><small>个人 {summary.soloStarted} · 双人 {summary.duoStarted}</small></article><article><span>完成次数</span><strong>{summary.attemptCompleted}</strong><small>与同一开始时间 cohort 对应</small></article><article><span>完成率</span><strong>{summary.completionRate === null ? "—" : `${(summary.completionRate * 100).toFixed(1)}%`}</strong><small>不是扫码转化率</small></article><article><span>双人完整房间</span><strong>{summary.duoGroupsFullyCompleted} / {summary.duoGroupsStarted}</strong><small>每个房间计一次</small></article></div>
        <section className="analyticsPanel"><h2>玩法完成情况</h2><p>个人 {summary.soloCompleted}/{summary.soloStarted} 次完成 · 双人 {summary.duoCompleted}/{summary.duoStarted} 次完成</p></section>
      </>}
      <section className="analyticsPanel"><div className="analyticsPanelTitle"><div><h2>自愿体验评分</h2><p>反馈按 Attempt 开始时间归入周期；评分自愿提交，存在自选择偏差。</p></div><strong>{summary.averageRating === null ? "—" : `${summary.averageRating.toFixed(1)} / 5`}</strong></div>
        <p>评分样本 {summary.feedbackCount}{summary.feedbackCount > 0 && summary.feedbackCount < 10 ? " · 样本有限" : ""}</p><div className="ratingDistribution">{ratingValues.map((value) => <span key={value}>{value} 分 <b>{summary.ratings[String(value) as keyof typeof summary.ratings]}</b></span>)}</div></section>
      <section className="analyticsPanel"><h2>题包版本表现</h2><p>按参与时绑定的不可变发布版本统计，已下架版本仍保留。</p>{versions.length === 0 ? <p>当前周期没有题包版本参与记录。</p> : <div className="analyticsTableWrap"><table className="analyticsTable"><thead><tr><th>版本</th><th>参与</th><th>完成</th><th>反馈</th></tr></thead><tbody>{versions.map((version) => <tr key={`${version.title}-${version.versionNo}`}><th scope="row">{version.title.replace(new RegExp(`\\s+V${version.versionNo}$`), "")} · V{version.versionNo}</th><td>{version.attemptStarted}</td><td>{version.attemptCompleted}</td><td>{version.feedbackCount}</td></tr>)}</tbody></table></div>}</section>
      <section className="analyticsLimits"><h2>数据口径与限制</h2><ul><li>完成率 = 已完成 Attempt / 参与 Attempt；分母为 0 时不计算。</li><li>完整双人房间要求同一房间内恰有两名已同意且均完成的双人 Attempt。</li><li>评分只覆盖主动反馈者，不等于全体顾客满意度。</li><li>当前没有扫码打开、独立顾客、复购、到店人数或营收数据，这些指标暂不支持。</li></ul></section>
    </section></div></main>;
}
