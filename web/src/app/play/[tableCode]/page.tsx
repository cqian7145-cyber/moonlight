import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { SoloPlay } from "@/features/solo/solo-play";

export const metadata: Metadata = {
  title: "个人玩法｜Moonlight",
  description: "完成三个轻松的小选择，查看本次个人趣味结果。",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function SoloPlayPage({ params }: { params: Promise<{ tableCode: string }> }) {
  return <Suspense fallback={<main className="soloPlayShell"><section className="soloPlayMessage" role="status">正在打开个人玩法…</section></main>}>
    <ResolvedSoloPlay params={params} />
  </Suspense>;
}

async function ResolvedSoloPlay({ params }: { params: Promise<{ tableCode: string }> }) {
  await connection();
  const { tableCode } = await params;
  return <SoloPlay tableCode={tableCode} />;
}
