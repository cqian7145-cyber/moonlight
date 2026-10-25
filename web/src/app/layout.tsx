import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moonlight｜酒馆里的轻松小互动",
  description: "扫一下桌上的二维码，用三个轻松选择给今晚添一点新鲜感。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}