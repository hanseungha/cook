import { defineConfig, devices } from "@playwright/test";

// 이미 개발 서버가 떠 있으면 PORT=3000 으로 재사용 (Next 16은 같은 디렉터리에 dev 서버를 하나만 허용)
const PORT = Number(process.env.PORT ?? 3100);

// macOS에서는 실제 GPU(Metal)로 렌더링해 사용자 화면과 같은 결과를 검증한다.
// GPU가 없는 환경(CI 등)은 SwiftShader 소프트웨어 렌더러로 대체.
const gpuArgs =
  process.platform === "darwin" && !process.env.CI
    ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium", // new headless: 하드웨어 GPU 사용 가능
        viewport: { width: 1280, height: 800 },
        launchOptions: { args: gpuArgs },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
