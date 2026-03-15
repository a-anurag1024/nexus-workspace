'use client';

/**
 * /app/dsa-review/page.tsx
 *
 * DSA Review App – three-phase study session:
 *   1. Problem Selection  – review/deselect algorithmically chosen problems
 *   2. Review Session     – work through each problem, reveal notes, mark answered/unanswered
 *   3. Completion         – save session results to the backend
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import AuthGuard from '@/components/AuthGuard';
import {
  fetchDsaSelectedProblems,
  fetchDsaProblemMarkdown,
  updateDsaReview,
  fetchDsaTracker,
  DsaProblem,
} from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

type ReviewStatus = 'pending' | 'answered' | 'unanswered';
type View = 'selecting' | 'reviewing' | 'done';

interface ReviewItem {
  problem: DsaProblem;
  selected: boolean;
  status: ReviewStatus;
  markdownContent: string | null;
  markdownLoading: boolean;
  markdownError: string | null;
  showMarkdown: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatLastReviewed(dateStr: string): string {
  if (!dateStr) return 'Never reviewed';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diff === 0) return 'Reviewed today';
  if (diff === 1) return '1 day ago';
  if (diff < 30) return `${diff} days ago`;
  if (diff < 365) return `${Math.floor(diff / 30)}mo ago`;
  return `${Math.floor(diff / 365)}y ago`;
}

function lastReviewedAccent(dateStr: string): string {
  if (!dateStr) return 'text-orange-500 font-semibold';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diff > 14) return 'text-amber-500';
  return 'text-emerald-600';
}

function statusIcon(status: ReviewStatus) {
  if (status === 'answered') return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 shrink-0">
      <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
      </svg>
    </span>
  );
  if (status === 'unanswered') return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-400 shrink-0">
      <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </span>
  );
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-gray-300 bg-white shrink-0" />
  );
}

// ─── DSA Progress Calendar ────────────────────────────────────────────────────

const CELL = 13;
const GAP = 2;

type CalRange = '1M' | '3M' | '1Y';

function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function intensityClass(count: number, isFuture = false): string {
  if (isFuture) return 'bg-gray-50';
  if (count === 0) return 'bg-gray-100';
  if (count === 1) return 'bg-blue-200';
  if (count <= 3) return 'bg-blue-400';
  if (count <= 5) return 'bg-blue-600';
  return 'bg-blue-800';
}

function getMonthsNeeded(range: CalRange): Array<{ year: number; month: number }> {
  const now = new Date();
  const count = range === '1M' ? 2 : range === '3M' ? 4 : 13;
  const result: Array<{ year: number; month: number }> = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return result;
}

function buildWeeks(
  daysData: Record<string, number>,
  weeksBack: number,
): { weeks: Array<Array<{ key: string; count: number; label: string; isFuture: boolean }>>; monthLabels: Array<{ weekIdx: number; label: string }> } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - today.getDay() - (weeksBack - 1) * 7);

  const weeks: Array<Array<{ key: string; count: number; label: string; isFuture: boolean }>> = [];
  const monthLabels: Array<{ weekIdx: number; label: string }> = [];
  let lastSeenMonth = -1;

  for (let w = 0; w < weeksBack; w++) {
    const week: Array<{ key: string; count: number; label: string; isFuture: boolean }> = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + w * 7 + d);
      const key = formatDateKey(date);
      const isFuture = date > today;
      const count = isFuture ? 0 : (daysData[key] ?? 0);
      if (!isFuture && date.getDate() === 1 && date.getMonth() !== lastSeenMonth) {
        monthLabels.push({ weekIdx: w, label: date.toLocaleString('default', { month: 'short' }) });
        lastSeenMonth = date.getMonth();
      }
      week.push({
        key,
        count,
        isFuture,
        label: isFuture ? '' : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}: ${count} problem${count !== 1 ? 's' : ''}`,
      });
    }
    weeks.push(week);
  }
  return { weeks, monthLabels };
}

function DsaProgressCalendar({ refreshKey = 0 }: { refreshKey?: number }) {
  const [range, setRange] = useState<CalRange>('1M');
  const [daysData, setDaysData] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [totalProblems, setTotalProblems] = useState(0);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(false);
    const months = getMonthsNeeded(range);
    Promise.all(months.map(({ year, month }) => fetchDsaTracker(year, month)))
      .then((results) => {
        const merged: Record<string, number> = {};
        let total = 0;
        for (const r of results) {
          for (const [date, entries] of Object.entries(r.days || {})) {
            merged[date] = (merged[date] ?? 0) + (entries?.length ?? 0);
          }
        }
        for (const count of Object.values(merged)) total += count;
        setDaysData(merged);
        setTotalProblems(total);
        let s = 0;
        const tod = new Date();
        tod.setHours(0, 0, 0, 0);
        for (let i = 0; i < 366; i++) {
          const d = new Date(tod);
          d.setDate(tod.getDate() - i);
          if (merged[formatDateKey(d)]) s++;
          else break;
        }
        setStreak(s);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [range, refreshKey]);

  const weeksBack = range === '1M' ? 6 : range === '3M' ? 13 : 53;
  const { weeks, monthLabels } = useMemo(() => buildWeeks(daysData, weeksBack), [daysData, weeksBack]);
  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
      <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">DSA Activity</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            {loading ? '…' : `${totalProblems} problems reviewed`}
            {!loading && streak > 0 && (
              <span className="ml-2 text-blue-600 font-medium">🔥 {streak}d streak</span>
            )}
          </p>
        </div>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          {(['1M', '3M', '1Y'] as CalRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 font-medium transition-colors ${range === r ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-20 animate-pulse rounded-lg bg-gray-100" />
      ) : error ? (
        <p className="text-xs text-gray-400 text-center py-6">Failed to load activity data.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="relative h-4 mb-0.5" style={{ width: `${28 + weeks.length * (CELL + GAP)}px` }}>
            {monthLabels.map((ml) => (
              <span
                key={`${ml.weekIdx}-${ml.label}`}
                className="absolute text-[10px] text-gray-400"
                style={{ left: `${28 + ml.weekIdx * (CELL + GAP)}px` }}
              >
                {ml.label}
              </span>
            ))}
          </div>
          <div className="flex items-start">
            <div className="flex flex-col mr-1 shrink-0" style={{ gap: `${GAP}px`, width: '22px' }}>
              {DAY_LABELS.map((d, i) => (
                <div
                  key={i}
                  className="flex items-center justify-end pr-1 text-[9px] text-gray-400"
                  style={{ height: `${CELL}px`, opacity: i % 2 === 1 ? 1 : 0 }}
                >
                  {d}
                </div>
              ))}
            </div>
            <div className="flex" style={{ gap: `${GAP}px` }}>
              {weeks.map((week, wIdx) => (
                <div key={wIdx} className="flex flex-col" style={{ gap: `${GAP}px` }}>
                  {week.map((cell) => (
                    <div
                      key={cell.key}
                      title={cell.label}
                      className={`rounded-sm cursor-default transition-transform hover:scale-110 ${intensityClass(cell.count, cell.isFuture)}`}
                      style={{ width: `${CELL}px`, height: `${CELL}px` }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-1">
        <span className="text-[9px] text-gray-400">Less</span>
        {[0, 1, 2, 4, 6].map((n) => (
          <div key={n} className={`rounded-sm ${intensityClass(n)}`} style={{ width: 10, height: 10 }} />
        ))}
        <span className="text-[9px] text-gray-400">More</span>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DsaReviewPage() {
  const [view, setView] = useState<View>('selecting');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [calRefreshKey, setCalRefreshKey] = useState(0);

  // ── Load selected problems ───────────────────────────────────────────────────

  const loadProblems = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const problems = await fetchDsaSelectedProblems();
      setItems(
        problems.map((p) => ({
          problem: p,
          selected: true,
          status: 'pending',
          markdownContent: null,
          markdownLoading: false,
          markdownError: null,
          showMarkdown: false,
        })),
      );
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load problems.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProblems();
  }, [loadProblems]);

  // ── Selection phase helpers ──────────────────────────────────────────────────

  const toggleSelect = (problemNumber: number) => {
    setItems((prev) =>
      prev.map((item) =>
        item.problem.problem_number === problemNumber
          ? { ...item, selected: !item.selected }
          : item,
      ),
    );
  };

  const toggleSelectAll = () => {
    const allSelected = items.every((i) => i.selected);
    setItems((prev) => prev.map((item) => ({ ...item, selected: !allSelected })));
  };

  const selectedItems = items.filter((i) => i.selected);

  const handleStartReview = () => {
    if (selectedItems.length === 0) return;
    // Keep only selected items, reset their status
    setItems(
      selectedItems.map((i) => ({ ...i, status: 'pending', showMarkdown: false })),
    );
    setCurrentIdx(0);
    setView('reviewing');
  };

  // ── Review phase helpers ─────────────────────────────────────────────────────

  const handleRevealMarkdown = async (idx: number) => {
    const item = items[idx];
    if (item.markdownContent !== null) {
      setItems((prev) =>
        prev.map((it, i) => (i === idx ? { ...it, showMarkdown: !it.showMarkdown } : it)),
      );
      return;
    }
    if (item.markdownLoading) return;
    setItems((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, markdownLoading: true, markdownError: null } : it)),
    );
    try {
      const md = await fetchDsaProblemMarkdown(
        item.problem.problem_number,
        item.problem.problem_tag,
      );
      setItems((prev) =>
        prev.map((it, i) =>
          i === idx ? { ...it, markdownContent: md, markdownLoading: false, showMarkdown: true } : it,
        ),
      );
    } catch (err) {
      setItems((prev) =>
        prev.map((it, i) =>
          i === idx
            ? {
                ...it,
                markdownLoading: false,
                markdownError: err instanceof Error ? err.message : 'Failed to load notes.',
              }
            : it,
        ),
      );
    }
  };

  const handleMark = (idx: number, answered: boolean) => {
    const newStatus: ReviewStatus = answered ? 'answered' : 'unanswered';
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, status: newStatus } : it)));
    // Advance to next pending problem
    const nextPending = items.findIndex((it, i) => i > idx && it.status === 'pending');
    if (nextPending !== -1) {
      setCurrentIdx(nextPending);
    } else {
      // Check if there's any pending before idx
      const anyPending = items.findIndex((it, i) => i !== idx && it.status === 'pending');
      if (anyPending !== -1) setCurrentIdx(anyPending);
      // else all are done – stay on current
    }
  };

  const allReviewed = items.length > 0 && items.every((i) => i.status !== 'pending');

  // ── Save session ─────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const results = items.map((i) => ({
        problem_number: i.problem.problem_number,
        answered: i.status === 'answered',
      }));
      await updateDsaReview(results);
      setSaved(true);
      setCalRefreshKey((k) => k + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save progress.');
    } finally {
      setSaving(false);
    }
  };

  const handleFinishSession = () => {
    setView('done');
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 1: SELECTION
  // ─────────────────────────────────────────────────────────────────────────────

  if (view === 'selecting') {
    return (
      <AuthGuard>
        <main className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-10">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">

            {/* ── Left: Problems ─────────────────────────────────────────────── */}
            <div className="lg:col-span-2">
              <div className="mb-6">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                      Today&apos;s DSA Review
                    </h1>
                    <p className="text-sm text-gray-500 mt-1">
                      Problems selected for your session — deselect any you want to skip
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href="/dsa-review/browse"
                      className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                      </svg>
                      Browse all
                    </Link>
                    <button
                      onClick={loadProblems}
                      disabled={loading}
                      className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
                    >
                      <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Refresh
                    </button>
                  </div>
                </div>
              </div>

              {loadError && (
                <div className="mb-4 rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
                  {loadError}
                </div>
              )}

              {/* Select all toggle */}
              {!loading && items.length > 0 && (
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    {selectedItems.length} of {items.length} selected
                  </span>
                  <button
                    onClick={toggleSelectAll}
                    className="text-xs text-blue-600 hover:underline font-medium"
                  >
                    {items.every((i) => i.selected) ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
              )}

              {/* Problem cards */}
              <div className="space-y-3">
                {loading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="h-28 animate-pulse rounded-2xl bg-gray-200" />
                    ))
                  : items.map((item) => {
                      const { problem, selected } = item;
                      return (
                        <button
                          key={problem.problem_number}
                          onClick={() => toggleSelect(problem.problem_number)}
                          className={`w-full text-left rounded-2xl border-2 p-4 transition-all duration-150 ${
                            selected
                              ? 'border-blue-500 bg-blue-50/60 shadow-sm'
                              : 'border-transparent bg-white shadow-sm hover:border-gray-200 hover:shadow'
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            {/* Checkbox */}
                            <div
                              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                                selected ? 'border-blue-500 bg-blue-500' : 'border-gray-300 bg-white'
                              }`}
                            >
                              {selected && (
                                <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-base font-bold text-gray-900">
                                  #{problem.problem_number}
                                </span>
                                <span className="text-base font-semibold text-gray-700 truncate">
                                  {problem.problem_tag.replace(/_/g, ' ')}
                                </span>
                              </div>

                              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                                <span className={lastReviewedAccent(problem.last_reviewed)}>
                                  {formatLastReviewed(problem.last_reviewed)}
                                </span>
                                <span className="text-gray-500">
                                  Reviewed {problem.number_of_times_reviewed}×
                                </span>
                                {problem.number_of_times_unanswered > 0 && (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 font-medium">
                                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z" />
                                    </svg>
                                    {problem.number_of_times_unanswered} missed
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* LeetCode chip */}
                            {problem.leetcode_url && (
                              <a
                                href={problem.leetcode_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="shrink-0 flex items-center gap-1 rounded-lg bg-orange-50 border border-orange-200 px-2.5 py-1 text-xs font-medium text-orange-600 hover:bg-orange-100 transition-colors"
                              >
                                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                                LC
                              </a>
                            )}
                          </div>
                        </button>
                      );
                    })}
              </div>

              {/* Start button */}
              {!loading && items.length > 0 && (
                <div className="mt-6">
                  <button
                    onClick={handleStartReview}
                    disabled={selectedItems.length === 0}
                    className="w-full rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-4 text-base font-semibold text-white shadow-lg shadow-blue-200 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-40 disabled:shadow-none transition-all"
                  >
                    {selectedItems.length === 0
                      ? 'Select at least one problem'
                      : `Start Session — ${selectedItems.length} problem${selectedItems.length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              )}

              {!loading && items.length === 0 && !loadError && (
                <div className="rounded-2xl bg-gray-50 border border-dashed border-gray-200 p-8 text-center">
                  <p className="text-sm text-gray-500">No problems available. Add some to the review table.</p>
                </div>
              )}
            </div>

            {/* ── Right: Calendar ─────────────────────────────────────────────── */}
            <div className="space-y-4">
              <DsaProgressCalendar refreshKey={calRefreshKey} />
              <div className="rounded-2xl bg-white border border-gray-100 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">How problems are selected</h3>
                <ul className="space-y-2 text-xs text-gray-500">
                  <li className="flex gap-2">
                    <span className="text-blue-500 font-bold shrink-0">1.</span>
                    Bottom 33% stalest problems form the candidate pool
                  </li>
                  <li className="flex gap-2">
                    <span className="text-blue-500 font-bold shrink-0">2.</span>
                    Problems you missed more often have higher weight
                  </li>
                  <li className="flex gap-2">
                    <span className="text-blue-500 font-bold shrink-0">3.</span>
                    5–8 problems selected via weighted random sample
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </main>
      </AuthGuard>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 2: REVIEWING
  // ─────────────────────────────────────────────────────────────────────────────

  if (view === 'reviewing') {
    const currentItem = items[currentIdx];

    return (
      <AuthGuard>
        <main className="mx-auto max-w-6xl px-4 py-6 md:px-6">

          {/* Header bar */}
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setView('selecting')}
                className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back
              </button>
              <h1 className="text-lg font-bold text-gray-900">Review Session</h1>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
                {items.filter((i) => i.status === 'answered').length} answered
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-400" />
                {items.filter((i) => i.status === 'unanswered').length} missed
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-gray-300" />
                {items.filter((i) => i.status === 'pending').length} pending
              </span>
            </div>
          </div>

          <div className="flex gap-5">
            {/* ── Left sidebar: problem list ───────────────────────────────── */}
            <div className="hidden md:flex flex-col w-56 shrink-0 gap-1 max-h-[calc(100vh-130px)] overflow-y-auto pr-1">
              {items.map((item, idx) => (
                <button
                  key={item.problem.problem_number}
                  onClick={() => setCurrentIdx(idx)}
                  className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-all ${
                    idx === currentIdx
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-white border border-gray-100 text-gray-700 hover:border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {statusIcon(item.status)}
                  <div className="min-w-0 flex-1">
                    <div className={`font-semibold text-xs ${idx === currentIdx ? 'text-white' : 'text-gray-900'}`}>
                      #{item.problem.problem_number}
                    </div>
                    <div className={`truncate text-xs mt-0.5 ${idx === currentIdx ? 'text-blue-100' : 'text-gray-500'}`}>
                      {item.problem.problem_tag.replace(/_/g, ' ')}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* ── Main area ────────────────────────────────────────────────── */}
            <div className="flex-1 min-w-0">
              {currentItem && (
                <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">

                  {/* Problem header */}
                  <div className="px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-2xl font-black text-blue-700">
                            #{currentItem.problem.problem_number}
                          </span>
                          <span className="text-xl font-semibold text-gray-800">
                            {currentItem.problem.problem_tag.replace(/_/g, ' ')}
                          </span>
                        </div>
                        {/* Mobile: problem list dropdown */}
                        <div className="md:hidden mt-1">
                          <select
                            value={currentIdx}
                            onChange={(e) => setCurrentIdx(Number(e.target.value))}
                            className="text-xs rounded-lg border border-gray-200 bg-white px-2 py-1 text-gray-700"
                          >
                            {items.map((it, idx) => (
                              <option key={it.problem.problem_number} value={idx}>
                                #{it.problem.problem_number} {it.problem.problem_tag.replace(/_/g, ' ')} ({it.status})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {currentItem.problem.leetcode_url && (
                        <a
                          href={currentItem.problem.leetcode_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 transition-colors shadow-sm"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                          Open on LeetCode
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
                    <div className="flex flex-wrap gap-6 text-sm">
                      <div className="flex flex-col">
                        <span className="text-xs text-gray-500 mb-0.5">Times reviewed</span>
                        <span className="font-semibold text-gray-900">{currentItem.problem.number_of_times_reviewed}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs text-gray-500 mb-0.5">Times missed</span>
                        <span className={`font-semibold ${currentItem.problem.number_of_times_unanswered > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
                          {currentItem.problem.number_of_times_unanswered}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs text-gray-500 mb-0.5">Last reviewed</span>
                        <span className={`font-semibold ${lastReviewedAccent(currentItem.problem.last_reviewed)}`}>
                          {formatLastReviewed(currentItem.problem.last_reviewed)}
                        </span>
                      </div>
                      {currentItem.problem.last_reviewed && (
                        <div className="flex flex-col">
                          <span className="text-xs text-gray-500 mb-0.5">Date</span>
                          <span className="font-semibold text-gray-900">{currentItem.problem.last_reviewed}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Current status badge */}
                  {currentItem.status !== 'pending' && (
                    <div className={`px-6 py-2 text-sm font-medium flex items-center gap-2 ${
                      currentItem.status === 'answered'
                        ? 'bg-emerald-50 text-emerald-700 border-b border-emerald-100'
                        : 'bg-red-50 text-red-600 border-b border-red-100'
                    }`}>
                      {statusIcon(currentItem.status)}
                      {currentItem.status === 'answered' ? 'Marked as answered' : 'Marked as not answered'}
                      <button
                        onClick={() =>
                          setItems((prev) =>
                            prev.map((it, i) => (i === currentIdx ? { ...it, status: 'pending' } : it)),
                          )
                        }
                        className="ml-auto text-xs opacity-60 hover:opacity-100 underline"
                      >
                        Undo
                      </button>
                    </div>
                  )}

                  {/* Review notes section */}
                  <div className="px-6 py-5">
                    <button
                      onClick={() => handleRevealMarkdown(currentIdx)}
                      disabled={currentItem.markdownLoading}
                      className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all ${
                        currentItem.showMarkdown
                          ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {currentItem.markdownLoading ? (
                        <svg className="h-4 w-4 animate-spin text-gray-500" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                      ) : (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={currentItem.showMarkdown ? 'M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21' : 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'} />
                        </svg>
                      )}
                      {currentItem.markdownLoading
                        ? 'Loading notes…'
                        : currentItem.showMarkdown
                        ? 'Hide review notes'
                        : 'Reveal review notes'}
                    </button>

                    {currentItem.markdownError && (
                      <div className="mt-3 rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
                        {currentItem.markdownError}
                      </div>
                    )}

                    {currentItem.showMarkdown && currentItem.markdownContent && (
                      <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-5 overflow-auto max-h-[500px] prose prose-sm max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-code:text-blue-700 prose-code:bg-blue-50 prose-code:px-1 prose-code:rounded prose-headings:text-gray-900 prose-p:text-gray-700 prose-li:text-gray-700">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {currentItem.markdownContent}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>

                  {/* Action buttons */}
                  {currentItem.status === 'pending' && (
                    <div className="px-6 pb-6 flex gap-3">
                      <button
                        onClick={() => handleMark(currentIdx, true)}
                        className="flex-1 flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-6 py-3.5 text-sm font-semibold text-white hover:bg-emerald-700 transition-colors shadow-sm"
                      >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                        Done — Answered
                      </button>
                      <button
                        onClick={() => handleMark(currentIdx, false)}
                        className="flex-1 flex items-center justify-center gap-2 rounded-2xl bg-red-500 px-6 py-3.5 text-sm font-semibold text-white hover:bg-red-600 transition-colors shadow-sm"
                      >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Done — Didn&apos;t Answer
                      </button>
                    </div>
                  )}

                  {currentItem.status !== 'pending' && (
                    <div className="px-6 pb-6 flex gap-3">
                      {currentIdx > 0 && (
                        <button
                          onClick={() => setCurrentIdx((i) => i - 1)}
                          className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                          </svg>
                          Previous
                        </button>
                      )}
                      {currentIdx < items.length - 1 && (
                        <button
                          onClick={() => setCurrentIdx((i) => i + 1)}
                          className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                        >
                          Next
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* All reviewed banner */}
              {allReviewed && (
                <div className="mt-4 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 p-5 text-white shadow-lg">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <svg className="h-5 w-5 text-blue-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
                        </svg>
                        <span className="font-semibold">All problems reviewed!</span>
                      </div>
                      <p className="text-sm text-blue-100">
                        {items.filter((i) => i.status === 'answered').length} answered · {items.filter((i) => i.status === 'unanswered').length} missed
                      </p>
                    </div>
                    <button
                      onClick={handleFinishSession}
                      className="rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-blue-700 hover:bg-blue-50 transition-colors shadow"
                    >
                      Finish &amp; Save →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </AuthGuard>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 3: DONE
  // ─────────────────────────────────────────────────────────────────────────────

  const answeredCount = items.filter((i) => i.status === 'answered').length;
  const unansweredCount = items.filter((i) => i.status === 'unanswered').length;

  return (
    <AuthGuard>
      <main className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-10">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">

          {/* Left: Session summary */}
          <div className="lg:col-span-2 space-y-4">
            {/* Summary card */}
            <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-700 p-6 text-white shadow-lg">
              <h1 className="text-xl font-bold mb-1">Session Complete 🎉</h1>
              <p className="text-blue-100 text-sm mb-5">Here&apos;s how you did today</p>
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-xl bg-white/20 p-4 text-center">
                  <div className="text-3xl font-black">{items.length}</div>
                  <div className="text-xs text-blue-100 mt-1">Reviewed</div>
                </div>
                <div className="rounded-xl bg-emerald-400/30 p-4 text-center">
                  <div className="text-3xl font-black text-emerald-100">{answeredCount}</div>
                  <div className="text-xs text-emerald-100 mt-1">Answered</div>
                </div>
                <div className="rounded-xl bg-red-400/30 p-4 text-center">
                  <div className="text-3xl font-black text-red-100">{unansweredCount}</div>
                  <div className="text-xs text-red-100 mt-1">Missed</div>
                </div>
              </div>
            </div>

            {/* Problems list */}
            <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h2 className="font-semibold text-gray-800 text-sm">Session Problems</h2>
              </div>
              <div className="divide-y divide-gray-50">
                {items.map((item) => (
                  <div key={item.problem.problem_number} className="flex items-center gap-3 px-5 py-3">
                    {statusIcon(item.status)}
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold text-gray-900 text-sm mr-2">
                        #{item.problem.problem_number}
                      </span>
                      <span className="text-gray-600 text-sm">
                        {item.problem.problem_tag.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      item.status === 'answered'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-red-100 text-red-600'
                    }`}>
                      {item.status === 'answered' ? 'Answered' : 'Missed'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Save / Actions */}
            {!saved ? (
              <div className="space-y-3">
                {saveError && (
                  <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
                    {saveError}
                  </div>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-4 text-base font-semibold text-white shadow-lg shadow-blue-200 hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 disabled:shadow-none transition-all flex items-center justify-center gap-2"
                >
                  {saving ? (
                    <>
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Saving progress…
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Save Progress
                    </>
                  )}
                </button>
                <button
                  onClick={() => { setView('reviewing'); }}
                  className="w-full rounded-xl border border-gray-200 bg-white px-6 py-3 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Back to review
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-5 py-4 flex items-center gap-3 text-emerald-700">
                  <svg className="h-5 w-5 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <div>
                    <p className="font-semibold text-sm">Progress saved!</p>
                    <p className="text-xs text-emerald-600 mt-0.5">Your review stats have been updated.</p>
                  </div>
                </div>
                <Link
                  href="/dsa-review"
                  onClick={() => {
                    setView('selecting');
                    setSaved(false);
                  }}
                  className="flex items-center justify-center gap-2 w-full rounded-2xl bg-blue-600 px-6 py-3.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
                >
                  Start a new session
                </Link>
                <Link
                  href="/dsa-review/browse"
                  className="flex items-center justify-center gap-2 w-full rounded-xl border border-gray-200 bg-white px-6 py-3 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Browse all problems
                </Link>
              </div>
            )}
          </div>

          {/* Right: Calendar */}
          <div>
            <DsaProgressCalendar refreshKey={calRefreshKey} />
          </div>
        </div>
      </main>
    </AuthGuard>
  );
}
