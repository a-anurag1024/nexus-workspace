'use client';

/**
 * /app/notion-review/page.tsx
 *
 * Notion Review App – displays:
 *  1. A list of 5 fetched topics
 *  2. An LLM trigger button per topic
 *  3. A checklist to mark topics as completed
 *  4. A progress calendar component
 *
 * All API calls include the Cognito JWT Bearer token via `authHeaders()`.
 */

import React, { useEffect, useState, useCallback } from 'react';
import AuthGuard from '@/components/AuthGuard';
import ProgressCalendar from '@/components/ProgressCalendar';
import { fetchTopics, triggerReview, Topic } from '@/lib/api';

// Status badge colours
const STATUS_COLOURS: Record<Topic['status'], string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
};

export default function NotionReviewPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const loadTopics = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchTopics();
      setTopics(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load topics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  const handleTrigger = async (topicId: string) => {
    setTriggering(topicId);
    try {
      await triggerReview(topicId);
      // Optimistically mark as in-progress
      setTopics((prev) =>
        prev.map((t) =>
          t.id === topicId ? { ...t, status: 'in_progress' } : t
        )
      );
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Trigger failed.');
    } finally {
      setTriggering(null);
    }
  };

  const toggleCheck = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setTopics((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: checked.has(id) ? 'pending' : 'completed' }
          : t
      )
    );
  };

  return (
    <AuthGuard>
      <main className="mx-auto max-w-4xl px-6 py-10">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Notion Review</h1>
            <p className="text-sm text-gray-500">
              LLM-powered study topic review
            </p>
          </div>
          <button
            onClick={loadTopics}
            disabled={loading}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && (
          <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* Topics list (2/3 width) */}
          <div className="lg:col-span-2 space-y-4">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-20 animate-pulse rounded-2xl bg-gray-200"
                />
              ))
            ) : (
              topics.map((topic) => (
                <div
                  key={topic.id}
                  className="flex items-start gap-4 rounded-2xl bg-white p-5 shadow"
                >
                  {/* Checklist checkbox */}
                  <input
                    type="checkbox"
                    checked={checked.has(topic.id)}
                    onChange={() => toggleCheck(topic.id)}
                    className="mt-1 h-4 w-4 cursor-pointer rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span
                        className={`text-base font-medium text-gray-900 ${
                          checked.has(topic.id) ? 'line-through text-gray-400' : ''
                        }`}
                      >
                        {topic.title}
                      </span>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          STATUS_COLOURS[topic.status]
                        }`}
                      >
                        {topic.status.replace('_', ' ')}
                      </span>
                    </div>

                    <button
                      onClick={() => handleTrigger(topic.id)}
                      disabled={triggering === topic.id || topic.status === 'completed'}
                      className="mt-3 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
                    >
                      {triggering === topic.id
                        ? 'Triggering…'
                        : '✨ Trigger LLM Review'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Progress calendar (1/3 width) */}
          <div className="space-y-4">
            <ProgressCalendar topics={topics} />
            <div className="rounded-2xl bg-white p-5 shadow">
              <h3 className="mb-3 text-sm font-semibold text-gray-700">
                Progress
              </h3>
              <div className="flex items-center gap-3">
                <div className="relative flex-1 h-2 rounded-full bg-gray-200">
                  <div
                    className="absolute left-0 top-0 h-2 rounded-full bg-indigo-600 transition-all"
                    style={{
                      width: topics.length
                        ? `${(checked.size / topics.length) * 100}%`
                        : '0%',
                    }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-600">
                  {checked.size}/{topics.length}
                </span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </AuthGuard>
  );
}
