import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@companion-space/avatar-engine", "@companion-space/lesson-board", "@companion-space/api-client"],
  devIndicators: false,
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
