import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { DuoPlay } from "@/features/duo/duo-play";

export const metadata: Metadata = { title: "双人默契｜Moonlight", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function DuoTablePlayPage({ params }: { params: Promise<{ tableCode: string }> }) {
  return <Suspense fallback={<main className="soloPlayShell"><section className="soloPlayMessage" role="status">正在打开双人玩法…</section></main>}>
    <ResolvedDuoPlay params={params} />
  </Suspense>;
}

async function ResolvedDuoPlay({ params }: { params: Promise<{ tableCode: string }> }) {
  await connection();
  const { tableCode } = await params;
  return <DuoPlay tableCode={tableCode} />;
}
