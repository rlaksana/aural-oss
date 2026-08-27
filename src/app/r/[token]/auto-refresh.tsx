"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-runs the server component on an interval so the report stays live. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);

  return null;
}
