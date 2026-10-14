import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cook — 인터랙티브 요리",
  description: "실사 수준의 인터랙티브 3D 요리 체험",
};

// 모바일 핀치 확대 방지: 고정 구도의 3D 장면이 화면 전체를 차지한다
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // 모바일 브라우저 주소창도 장면 배경과 같은 흰색
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
