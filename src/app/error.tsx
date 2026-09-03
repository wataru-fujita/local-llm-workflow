"use client";

import Link from "next/link";
import { useEffect } from "react";

/** Route error boundary (phase 7) - a render/runtime crash shows this, not a blank page. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">エラーが発生しました</h1>
      <p className="text-sm text-zinc-500">
        {error.message || "予期しないエラーです。"}
      </p>
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900"
        >
          再試行
        </button>
        <Link
          href="/"
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
        >
          トップへ
        </Link>
      </div>
    </main>
  );
}
