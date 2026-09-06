import type { NextConfig } from "next";

// DESIGN D11：自托管 standalone（node runtime）——需长连接 + 拉起 sidecar + 持状态，
// 非 serverless/edge。sidecar 生命周期倾向由 server 启动时拉起（instrumentation），
// 崩溃重启，见 DESIGN §12.7 / §11「双平面 IPC 故障域」。
const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
