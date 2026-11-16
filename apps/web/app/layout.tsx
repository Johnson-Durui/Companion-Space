import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SidebarNav } from "@/components/sidebar-nav";

import "./globals.css";
import "katex/dist/katex.min.css";

export const metadata: Metadata = {
  title: process.env.APP_DISPLAY_NAME?.trim() || "Companion Space",
  description: "开源二次元伴学空间，支持自建知识库、自带模型 Key、角色工作室与会话复盘。",
};

export const dynamic = "force-dynamic";
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
} as const;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const displayName = process.env.APP_DISPLAY_NAME?.trim() || "Companion Space";

  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div className="app-shell">
          <SidebarNav displayName={displayName} />
          <main id="main-content" className="app-main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
