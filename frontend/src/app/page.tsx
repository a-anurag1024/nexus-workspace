'use client';

import AuthGuard from '@/components/AuthGuard';
import Link from 'next/link';

export default function HomePage() {
  return (
    <AuthGuard>
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="mb-2 text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="mb-8 text-gray-500">
          Welcome to Nexus Workspace. Select an app below to get started.
        </p>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href="/notion-review"
            className="group rounded-2xl bg-white p-6 shadow transition hover:shadow-md"
          >
            <div className="mb-3 text-3xl">📚</div>
            <h2 className="text-lg font-semibold text-gray-900 group-hover:text-indigo-600">
              Notion Review
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              LLM-powered review of your Notion study topics.
            </p>
          </Link>

          <Link
            href="/dsa-review"
            className="group rounded-2xl bg-white p-6 shadow transition hover:shadow-md"
          >
            <div className="mb-3 text-3xl">🧩</div>
            <h2 className="text-lg font-semibold text-gray-900 group-hover:text-blue-600">
              DSA Review
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Spaced-repetition LeetCode sessions with progress tracking.
            </p>
          </Link>
        </div>
      </main>
    </AuthGuard>
  );
}
