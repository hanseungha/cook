import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 스크린샷/영상 캡처 시 화면을 가리지 않도록 개발 배지 숨김
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
