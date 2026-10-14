import { Suspense } from "react";
import { Experience } from "./Experience";

export default function Home() {
  return (
    <main className="fixed inset-0 bg-white">
      <Suspense fallback={null}>
        <Experience />
      </Suspense>
    </main>
  );
}
