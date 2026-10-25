import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EntryLoading, TableEntryView } from "@/features/entry/table-entry-view";
import { loadCustomerEntryPage } from "@/server/customer-entry";

export const metadata: Metadata = {
  title: "桌边轻互动｜Moonlight",
  description: "读取本桌当前上架的轻松玩法。",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type TableEntryPageProps = {
  params: Promise<{ tableCode: string }>;
};

export default function TableEntryPage({ params }: TableEntryPageProps) {
  return (
    <Suspense fallback={<EntryLoading />}>
      <ResolvedTableEntry params={params} />
    </Suspense>
  );
}

async function ResolvedTableEntry({ params }: TableEntryPageProps) {
  await connection();
  const { tableCode } = await params;
  const entry = await loadCustomerEntryPage(tableCode);
  if (entry.status === "not_found") notFound();
  return <TableEntryView entry={entry} />;
}
