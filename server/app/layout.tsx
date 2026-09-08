import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "yunzone-infer 控制面",
  description:
    "分布式推理资源池：服务器持有推理图、客户端持有算力（叠加层，只复用不修改 DCinfer）",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="topbar">
          <div className="shell topbar-inner">
            <a className="brand" href="/" style={{ textDecoration: "none", color: "inherit" }}>
              <span className="brand-mark">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <circle cx="5" cy="6" r="2" />
                  <circle cx="19" cy="6" r="2" />
                  <circle cx="5" cy="18" r="2" />
                  <circle cx="19" cy="18" r="2" />
                  <path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3" />
                </svg>
              </span>
              <span>
                <span className="brand-name">yunzone-infer</span>{" "}
                <span className="brand-sub">// 控制面</span>
              </span>
            </a>
            <span className="topbar-spacer" />
            <nav className="topbar-nav">
              <a className="nav-link" href="/">概览</a>
              <a className="nav-link" href="/admin">管理控制台</a>
            </nav>
          </div>
        </header>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
