import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "yunzone-infer 控制面",
  description:
    "分布式推理资源池：服务器持有推理图、客户端持有算力（叠加层，只复用不修改 DCinfer）",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
