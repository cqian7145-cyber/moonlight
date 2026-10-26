import type { Metadata } from "next";
import { JoinInvitation } from "@/features/duo/join-invitation";

export const metadata: Metadata = { title: "加入双人玩法｜Moonlight", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function JoinPage() {
  return <JoinInvitation />;
}
