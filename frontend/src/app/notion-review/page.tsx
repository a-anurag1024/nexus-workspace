'use client';

/**
 * /app/notion-review/page.tsx
 *
 * Notion Review App – three-phase study session:
 *   1. Topic Selection  – pick from 5 least-recently reviewed topics
 *   2. Review Session   – read AI-generated questions per topic
 *   3. Completion       – mark session as reviewed (logged to backend)
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import ProgressCalendar from '@/components/ProgressCalendar';
import {
  fetchTopics,
  triggerReview,
  fetchReviewResult,
  logReview,
  Topic,
  ReviewJob,
} from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type View = 'selecting' | 'reviewing' | 'done';

interface QueueItem {
  topic: Topic;
  requestId: string | null;
  jobStatus: ReviewJob['status'] | 'pending' | 'triggering';
  questions: string[];
  error: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * On Android/iOS, replace https:// with notion:// so the Notion app opens
 * directly instead of the browser. Falls back to the web URL on desktop.
 */
function notionHref(webUrl: string): string {
  if (typeof navigator === 'undefined') return webUrl;
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isMobile && webUrl.startsWith('https://')) {
    return webUrl.replace('https://', 'notion://');
  }
  return webUrl;
}

function formatLastReviewed(lr: Topic['lastReviewed']): string {
  if (!lr) return 'Never reviewed';
  let dateStr: string | undefined;
  if (typeof lr === 'string') {
    dateStr = lr;
  } else if (typeof lr === 'object' && lr.start) {
    dateStr = lr.start;
  }
  if (!dateStr) return 'Never reviewed';

  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diff === 0) return 'Reviewed today';
  if (diff === 1) return '1 day ago';
  if (diff < 30) return `${diff} days ago`;
  if (diff < 365) return `${Math.floor(diff / 30)}mo ago`;
  return `${Math.floor(diff / 365)}y ago`;
}

function lastReviewedAccent(lr: Topic['lastReviewed']): string {
  if (!lr) return 'text-orange-500 font-semibold';
  let dateStr: string | undefined;
  if (typeof lr === 'string') dateStr = lr;
  else if (typeof lr === 'object' && lr.start) dateStr = lr.start;
  if (!dateStr) return 'text-orange-500 font-semibold';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diff > 14) return 'text-amber-500';
  return 'text-emerald-600';
}

const SUBJECT_PALETTE: Record<string, string> = {
  'AI': 'bg-violet-100 text-violet-700',
  'Machine Learning': 'bg-violet-100 text-violet-700',
  'Math': 'bg-blue-100 text-blue-700',
  'Physics': 'bg-cyan-100 text-cyan-700',
  'Chemistry': 'bg-teal-100 text-teal-700',
  'Biology': 'bg-green-100 text-green-700',
  'Computer Science': 'bg-orange-100 text-orange-700',
  'Programming': 'bg-orange-100 text-orange-700',
  'History': 'bg-yellow-100 text-yellow-800',
  'Economics': 'bg-pink-100 text-pink-700',
};
function subjectBadge(subject?: string): string {
  if (!subject) return 'bg-gray-100 text-gray-500';
  return SUBJECT_PALETTE[subject] ?? 'bg-indigo-100 text-indigo-700';
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function NotionReviewPage() {
  const [view, setView] = useState<View>('selecting');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loadingTopics, setLoadingTopics] = useState(true);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);

  const [logging, setLogging] = useState(false);
  const [logged, setLogged] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [calRefreshKey, setCalRefreshKey] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load topics ──────────────────────────────────────────────────────────────

  const loadTopics = useCallback(async () => {
    try {
      setLoadingTopics(true);
      setTopicsError(null);
      const data = await fetchTopics();
      setTopics(data);
      // Pre-select all topics
      setSelected(new Set(data.map((t) => t.id)));
    } catch (err) {
      setTopicsError(err instanceof Error ? err.message : 'Failed to load topics.');
    } finally {
      setLoadingTopics(false);
    }
  }, []);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  // ── Polling for the current queue item ───────────────────────────────────────

  useEffect(() => {
    if (view !== 'reviewing') return;
    const item = queue[currentIdx];
    if (!item) return;
    if (item.jobStatus === 'completed' || item.jobStatus === 'failed') return;
    if (!item.requestId) return;

    const poll = async () => {
      try {
        const job = await fetchReviewResult(item.requestId!);
        if (job.status === 'completed') {
          setQueue((prev) =>
            prev.map((q, i) =>
              i === currentIdx
                ? { ...q, jobStatus: 'completed', questions: job.questions ?? [] }
                : q,
            ),
          );
        } else if (job.status === 'failed') {
          setQueue((prev) =>
            prev.map((q, i) =>
              i === currentIdx
                ? {
                    ...q,
                    jobStatus: 'failed',
                    error: job.error ?? 'Review generation failed.',
                  }
                : q,
            ),
          );
        }
      } catch {
        // silently retry
      }
    };

    poll(); // immediate first check
    pollRef.current = setInterval(poll, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [view, currentIdx, queue]);

  // ── Start review session ─────────────────────────────────────────────────────

  const handleStartReview = async () => {
    const selectedTopics = topics.filter((t) => selected.has(t.id));
    if (selectedTopics.length === 0) return;

    // Build initial queue
    const initialQueue: QueueItem[] = selectedTopics.map((t) => ({
      topic: t,
      requestId: null,
      jobStatus: 'triggering',
      questions: [],
      error: null,
    }));
    setQueue(initialQueue);
    setCurrentIdx(0);
    setView('reviewing');

    // Fire all trigger requests in parallel
    const triggered = await Promise.allSettled(
      selectedTopics.map((t) => triggerReview(t.id, t.notionPageId)),
    );

    setQueue((prev) =>
      prev.map((item, i) => {
        const result = triggered[i];
        if (result.status === 'fulfilled') {
          return { ...item, requestId: result.value.requestId, jobStatus: 'queued' };
        }
        return {
          ...item,
          jobStatus: 'failed',
          error: result.reason instanceof Error ? result.reason.message : 'Trigger failed',
        };
      }),
    );
  };

  // ── Navigate review queue ────────────────────────────────────────────────────

  const handleNext = () => {
    if (currentIdx < queue.length - 1) {
      setCurrentIdx((i) => i + 1);
    } else {
      setView('done');
    }
  };

  // ── Log review ───────────────────────────────────────────────────────────────

  const handleLogReview = async () => {
    setLogging(true);
    setLogError(null);
    try {
      await logReview(
        queue.map((q) => ({
          notionPageId: q.topic.notionPageId,
          topicId: q.topic.id,
          topicName: q.topic.title,
          subject: q.topic.subject,
          questions: q.questions,
        })),
      );
      setLogged(true);
      setCalRefreshKey((k) => k + 1);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : 'Failed to log review.');
    } finally {
      setLogging(false);
    }
  };

  // ── Toggle topic selection ───────────────────────────────────────────────────

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <AuthGuard>
      <main className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-10">

        {/* ══ PHASE 1: TOPIC SELECTION ══════════════════════════════════════════ */}
        {view === 'selecting' && (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
            {/* Left: topic list */}
            <div className="lg:col-span-2">
              {/* Header */}
              <div className="mb-6">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                      Today&apos;s Review
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">
                      Select the topics you&apos;d like to study today
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href="/notion-review/browse"
                      className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                      </svg>
                      Browse all
                    </Link>
                    <button
                      onClick={loadTopics}
                      disabled={loadingTopics}
                      className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
                    >
                      <svg className={`h-4 w-4 ${loadingTopics ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Refresh
                    </button>
                  </div>
                </div>
              </div>

              {topicsError && (
                <div className="mb-4 rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
                  {topicsError}
                </div>
              )}

              {/* Topic cards */}
              <div className="space-y-3">
                {loadingTopics
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="h-24 animate-pulse rounded-2xl bg-gray-200" />
                    ))
                  : topics.map((topic) => {
                      const isSelected = selected.has(topic.id);
                      return (
                        <button
                          key={topic.id}
                          onClick={() => toggleSelect(topic.id)}
                          className={`w-full text-left rounded-2xl border-2 p-4 transition-all duration-150 ${
                            isSelected
                              ? 'border-indigo-500 bg-indigo-50/60 shadow-sm'
                              : 'border-transparent bg-white shadow-sm hover:border-gray-200 hover:shadow'
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            {/* Checkbox indicator */}
                            <div
                              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                                isSelected
                                  ? 'border-indigo-500 bg-indigo-500'
                                  : 'border-gray-300 bg-white'
                              }`}
                            >
                              {isSelected && (
                                <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-base font-semibold text-gray-900 leading-snug">
                                  {topic.title}
                                </span>
                                {topic.subject && (
                                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${subjectBadge(topic.subject)}`}>
                                    {topic.subject}
                                  </span>
                                )}
                              </div>

                              <div className="mt-1.5 flex items-center gap-3 flex-wrap">
                                <span className={`text-xs ${lastReviewedAccent(topic.lastReviewed)}`}>
                                  {formatLastReviewed(topic.lastReviewed)}
                                </span>
                                {topic.notionPageUrl && (
                                  <a
                                    href={notionHref(topic.notionPageUrl)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-indigo-600 transition-colors"
                                  >
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                    Open in Notion
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
              </div>

              {/* Start button */}
              {!loadingTopics && topics.length > 0 && (
                <div className="mt-6">
                  <button
                    onClick={handleStartReview}
                    disabled={selected.size === 0}
                    className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-4 text-base font-semibold text-white shadow-lg shadow-indigo-200 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-40 disabled:shadow-none transition-all"
                  >
                    {selected.size === 0
                      ? 'Select at least one topic'
                      : `Start Review Session → ${selected.size} topic${selected.size !== 1 ? 's' : ''}`}
                  </button>
                </div>
              )}
            </div>

            {/* Right: activity calendar */}
            <div className="space-y-4">
              <ProgressCalendar refreshKey={calRefreshKey} />
            </div>
          </div>
        )}

        {/* ══ PHASE 2: REVIEW SESSION ═══════════════════════════════════════════ */}
        {view === 'reviewing' && queue.length > 0 && (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
            {/* Main review panel */}
            <div className="lg:col-span-2">
              {/* Progress header */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-500">
                    Topic {currentIdx + 1} of {queue.length}
                  </span>
                  <span className="text-sm font-medium text-indigo-600">
                    {Math.round(((currentIdx) / queue.length) * 100)}% done
                  </span>
                </div>
                {/* Progress bar */}
                <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500"
                    style={{ width: `${(currentIdx / queue.length) * 100}%` }}
                  />
                </div>
                {/* Step pills */}
                <div className="flex gap-1.5 mt-3">
                  {queue.map((q, i) => (
                    <div
                      key={q.topic.id}
                      className={`h-1.5 flex-1 rounded-full transition-colors ${
                        i < currentIdx
                          ? 'bg-emerald-500'
                          : i === currentIdx
                          ? 'bg-indigo-500'
                          : 'bg-gray-200'
                      }`}
                    />
                  ))}
                </div>
              </div>

              {/* Current topic card */}
              {(() => {
                const item = queue[currentIdx];
                if (!item) return null;

                return (
                  <div className="rounded-3xl bg-white shadow-sm border border-gray-100 overflow-hidden">
                    {/* Topic header */}
                    <div className="px-6 pt-6 pb-5 border-b border-gray-100 bg-gradient-to-br from-indigo-50/50 to-purple-50/50">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div>
                          <h2 className="text-xl font-bold text-gray-900">{item.topic.title}</h2>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            {item.topic.subject && (
                              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${subjectBadge(item.topic.subject)}`}>
                                {item.topic.subject}
                              </span>
                            )}
                            <span className={`text-xs ${lastReviewedAccent(item.topic.lastReviewed)}`}>
                              {formatLastReviewed(item.topic.lastReviewed)}
                            </span>
                          </div>
                        </div>
                        {item.topic.notionPageUrl && (
                          <a
                            href={item.topic.notionPageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:text-indigo-600 hover:border-indigo-200 transition-colors bg-white"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                            Notion
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Questions body */}
                    <div className="px-6 py-5">
                      {item.jobStatus === 'error' || item.jobStatus === 'failed' ? (
                        <div className="rounded-xl bg-red-50 border border-red-100 p-4 text-sm text-red-700">
                          <p className="font-medium">Failed to generate questions</p>
                          <p className="mt-1 text-red-500">{item.error}</p>
                        </div>
                      ) : item.jobStatus === 'completed' ? (
                        <div>
                          <div className="flex items-center gap-2 mb-4">
                            <div className="h-5 w-5 rounded-full bg-emerald-100 flex items-center justify-center">
                              <svg className="h-3 w-3 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                            <span className="text-sm font-medium text-gray-700">
                              {item.questions.length} review questions
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 mb-4 italic">
                            Think through each question before moving on. There&apos;s no need to write answers — just mentally recall.
                          </p>
                          <ol className="space-y-3">
                            {item.questions.map((q, qi) => (
                              <li key={qi} className="flex gap-3">
                                <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
                                  {qi + 1}
                                </span>
                                <span className="text-sm text-gray-800 leading-relaxed pt-0.5">{q}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      ) : (
                        /* Loading / queued / processing */
                        <div className="py-8">
                          <div className="flex flex-col items-center gap-3">
                            <div className="flex gap-1">
                              {[0, 1, 2].map((i) => (
                                <div
                                  key={i}
                                  className="h-2.5 w-2.5 rounded-full bg-indigo-400 animate-bounce"
                                  style={{ animationDelay: `${i * 0.15}s` }}
                                />
                              ))}
                            </div>
                            <p className="text-sm text-gray-500">
                              {item.jobStatus === 'triggering'
                                ? 'Queueing review…'
                                : 'Generating questions with AI…'}
                            </p>
                          </div>
                          <div className="mt-6 space-y-2.5">
                            {Array.from({ length: 5 }).map((_, i) => (
                              <div
                                key={i}
                                className="h-4 animate-pulse rounded-md bg-gray-100"
                                style={{ width: `${70 + Math.random() * 30}%` }}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Action footer */}
                    <div className="px-6 pb-6">
                      <button
                        onClick={handleNext}
                        disabled={
                          item.jobStatus !== 'completed' &&
                          item.jobStatus !== 'failed' &&
                          item.jobStatus !== 'error'
                        }
                        className="w-full rounded-2xl bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-3.5 text-sm font-semibold text-white shadow-md shadow-indigo-200 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-40 disabled:shadow-none transition-all"
                      >
                        {currentIdx < queue.length - 1
                          ? `Done with this topic → Next: ${queue[currentIdx + 1]?.topic.title ?? ''}`
                          : 'Finish Review →'}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Sidebar: queue overview + calendar */}
            <div className="space-y-4">
              {/* Topics queue */}
              <div className="rounded-2xl bg-white shadow-sm border border-gray-100 p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Session Topics</h3>
                <div className="space-y-2">
                  {queue.map((q, i) => (
                    <div
                      key={q.topic.id}
                      className={`flex items-center gap-2.5 rounded-xl px-3 py-2 ${
                        i === currentIdx ? 'bg-indigo-50' : ''
                      }`}
                    >
                      <div
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                          i < currentIdx
                            ? 'bg-emerald-500 text-white'
                            : i === currentIdx
                            ? 'bg-indigo-600 text-white font-bold'
                            : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        {i < currentIdx ? (
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          i + 1
                        )}
                      </div>
                      <span className={`text-sm truncate ${i === currentIdx ? 'font-medium text-indigo-900' : i < currentIdx ? 'text-gray-400 line-through' : 'text-gray-600'}`}>
                        {q.topic.title}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <ProgressCalendar refreshKey={calRefreshKey} />
            </div>
          </div>
        )}

        {/* ══ PHASE 3: COMPLETION ═══════════════════════════════════════════════ */}
        {view === 'done' && (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
            {/* Completion card */}
            <div className="lg:col-span-2">
              <div className="rounded-3xl bg-white shadow-sm border border-gray-100 overflow-hidden">
                {/* Celebration header */}
                <div className="px-6 pt-8 pb-6 text-center bg-gradient-to-br from-emerald-50 to-teal-50 border-b border-gray-100">
                  <div className="text-4xl mb-3">🎉</div>
                  <h2 className="text-2xl font-bold text-gray-900">Review Complete!</h2>
                  <p className="text-gray-500 mt-1 text-sm">
                    {queue.length} topic{queue.length !== 1 ? 's' : ''} ·{' '}
                    {queue.reduce((sum, q) => sum + q.questions.length, 0)} questions reviewed
                  </p>
                </div>

                {/* Reviewed topics list */}
                <div className="px-6 py-5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                    Topics covered
                  </h3>
                  <div className="space-y-2">
                    {queue.map((q) => (
                      <div key={q.topic.id} className="flex items-center gap-3 py-1.5">
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                          <svg className="h-3.5 w-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-800">{q.topic.title}</span>
                          {q.topic.subject && (
                            <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${subjectBadge(q.topic.subject)}`}>
                              {q.topic.subject}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-gray-400 shrink-0">
                          {q.questions.length} Qs
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="px-6 pb-6 space-y-3">
                  {logged ? (
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-center">
                      <div className="flex items-center justify-center gap-2 text-emerald-700 font-semibold">
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Saved to your review history!
                      </div>
                      <p className="text-xs text-emerald-600 mt-1">
                        Notion pages updated · Activity tracker refreshed
                      </p>
                    </div>
                  ) : (
                    <>
                      {logError && (
                        <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
                          {logError}
                        </div>
                      )}
                      <button
                        onClick={handleLogReview}
                        disabled={logging}
                        className="w-full rounded-2xl bg-emerald-600 px-6 py-4 text-base font-semibold text-white shadow-lg shadow-emerald-200 hover:bg-emerald-700 disabled:opacity-50 disabled:shadow-none transition-all flex items-center justify-center gap-2"
                      >
                        {logging ? (
                          <>
                            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            Saving…
                          </>
                        ) : (
                          <>
                            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            Mark as Reviewed &amp; Save Progress
                          </>
                        )}
                      </button>
                    </>
                  )}

                  <button
                    onClick={() => {
                      setView('selecting');
                      setQueue([]);
                      setCurrentIdx(0);
                      setLogged(false);
                      setLogError(null);
                      loadTopics();
                    }}
                    className="w-full rounded-2xl border border-gray-200 px-6 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    ← Start a New Session
                  </button>
                </div>
              </div>
            </div>

            {/* Sidebar: activity calendar */}
            <div>
              <ProgressCalendar refreshKey={calRefreshKey} />
            </div>
          </div>
        )}
      </main>
    </AuthGuard>
  );
}


