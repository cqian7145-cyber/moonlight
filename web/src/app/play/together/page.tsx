import type { Metadata } from "next";
import { DuoPlay } from "@/features/duo/duo-play";

export const metadata: Metadata = { title: "双人默契｜Moonlight", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function CurrentDuoPlayPage() {
  return <DuoPlay />;
}
