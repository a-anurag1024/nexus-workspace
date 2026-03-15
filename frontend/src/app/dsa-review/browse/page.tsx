'use client';

/**
 * /app/dsa-review/browse/page.tsx
 *
 * DSA Problem Browser – displays all problems with stats.
 * Supports sorting by last reviewed date and number of times unanswered.
 * Allows fetching and viewing rendered markdown for any problem.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import AuthGuard from '@/components/AuthGuard';
import { fetchDsaAllProblems, fetchDsaProblemMarkdown, DsaProblemFull } from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLastReviewed(dateStr: string): string {
  if (!dateStr) return 'Never';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return '1 day ago';
  if (diff < 30) return `${diff}d ago`;
  if (diff < 365) return `${Math.floor(diff / 30)}mo ago`;
  return `${Math.floor(diff / 365)}y ago`;
}

function sortKey(dateStr: string): number {
  if (!dateStr) return 0;
  return new Date(dateStr).getTime();
}

type SortField = 'last_reviewed' | 'number_of_times_unanswered' | 'problem_number' | 'number_of_times_reviewed';
type SortDir = 'asc' | 'desc';

// ─── Markdown Modal ────────────────────────────────────────────────────────────

interface MarkdownModalProps {
  problem: DsaProblemFull;
  onClose: () => void;
}

function MarkdownModal({ problem, onClose }: MarkdownModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchDsaProblemMarkdown(problem.problem_number, problem.problem_tag)
      .then((md) => {
        setContent(md);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load notes.');
        setLoading(false);
      });
  }, [problem.problem_number, problem.problem_tag]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl overflow-hidden">
        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50 shrink-0">
          <div>
            <h2 className="font-bold text-gray-900">
              <span className="text-blue-700 mr-2">#{problem.problem_number}</span>
              {problem.problem_tag.replace(/_/g, ' ')}
            </h2>
            {problem.leetcode_url && (
              <a
                href={problem.leetcode_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 flex items-center gap-1 text-xs text-orange-600 hover:underline"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Open on LeetCode
              </a>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Stats strip */}
        <div className="flex gap-6 px-6 py-3 border-b border-gray-100 bg-gray-50 text-xs text-gray-600 shrink-0">
          <span><strong className="text-gray-800">{problem.number_of_times_reviewed}</strong> reviews</span>
          <span><strong className={problem.number_of_times_unanswered > 0 ? 'text-amber-600' : 'text-gray-800'}>{problem.number_of_times_unanswered}</strong> missed</span>
          <span>Last: <strong className="text-gray-800">{formatLastReviewed(problem.last_reviewed)}</strong></span>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <svg className="h-7 w-7 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            </div>
          )}
          {error && (
            <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-4 text-sm text-red-700">{error}</div>
          )}
          {content && !loading && (
            <div className="prose prose-sm max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-code:text-blue-700 prose-code:bg-blue-50 prose-code:px-1 prose-code:rounded prose-headings:text-gray-900 prose-p:text-gray-700 prose-li:text-gray-700 prose-blockquote:border-blue-400 prose-blockquote:bg-blue-50 prose-blockquote:py-1 prose-blockquote:px-3 prose-blockquote:rounded-r-lg">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Problem Row ───────────────────────────────────────────────────────────────

interface ProblemRowProps {
  problem: DsaProblemFull;
  onViewNotes: (problem: DsaProblemFull) => void;
}

function ProblemRow({ problem, onViewNotes }: ProblemRowProps) {
  const hasBeenReviewed = !!problem.last_reviewed;
  const daysSince = hasBeenReviewed
    ? Math.floor((Date.now() - new Date(problem.last_reviewed).getTime()) / 86_400_000)
    : null;

  const lastReviewedClass =
    daysSince === null
      ? 'bg-orange-100 text-orange-700'
      : daysSince > 30
      ? 'bg-amber-100 text-amber-700'
      : daysSince > 14
      ? 'bg-yellow-100 text-yellow-700'
      : 'bg-emerald-100 text-emerald-700';

  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3 shadow-sm hover:shadow-md hover:border-gray-200 transition-all">
      {/* Problem number */}
      <span className="shrink-0 inline-flex items-center justify-center rounded-md bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs font-mono font-bold text-blue-700 min-w-[44px]">
        #{problem.problem_number}
      </span>

      {/* Problem tag */}
      <span className="flex-1 min-w-0 font-medium text-gray-800 truncate text-sm">
        {problem.problem_tag.replace(/_/g, ' ')}
      </span>

      {/* Stats */}
      <div className="hidden sm:flex items-center gap-4 text-xs text-gray-500 shrink-0">
        <span title="Times reviewed" className="flex items-center gap-1">
          <svg className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {problem.number_of_times_reviewed}×
        </span>
        {problem.number_of_times_unanswered > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 font-medium">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z" />
            </svg>
            {problem.number_of_times_unanswered} missed
          </span>
        )}
      </div>

      {/* Last reviewed badge */}
      <span className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${lastReviewedClass}`}>
        {formatLastReviewed(problem.last_reviewed)}
      </span>

      {/* LeetCode link */}
      {problem.leetcode_url ? (
        <a
          href={problem.leetcode_url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 flex items-center gap-1 rounded-lg border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-600 hover:bg-orange-100 transition-colors"
          title="Open on LeetCode"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          LC
        </a>
      ) : (
        <span className="shrink-0 w-[44px]" />
      )}

      {/* Notes button */}
      <button
        onClick={() => onViewNotes(problem)}
        className="shrink-0 flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition-colors"
        title="View review notes"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
        Notes
      </button>
    </div>
  );
}

// ─── Sort Header Button ────────────────────────────────────────────────────────

function SortButton({
  field,
  label,
  currentField,
  currentDir,
  onClick,
}: {
  field: SortField;
  label: string;
  currentField: SortField;
  currentDir: SortDir;
  onClick: (field: SortField) => void;
}) {
  const active = field === currentField;
  return (
    <button
      onClick={() => onClick(field)}
      className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-blue-600 text-white'
          : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
      }`}
    >
      {label}
      {active && (
        <svg
          className={`h-3.5 w-3.5 transition-transform ${currentDir === 'asc' ? 'rotate-0' : 'rotate-180'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      )}
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DsaBrowsePage() {
  const [problems, setProblems] = useState<DsaProblemFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('last_reviewed');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [modalProblem, setModalProblem] = useState<DsaProblemFull | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDsaAllProblems();
      setProblems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load problems.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'last_reviewed' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return problems.filter(
      (p) =>
        !q ||
        p.problem_tag.toLowerCase().includes(q) ||
        String(p.problem_number).includes(q),
    );
  }, [problems, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'last_reviewed') {
        cmp = sortKey(a.last_reviewed) - sortKey(b.last_reviewed);
      } else if (sortField === 'number_of_times_unanswered') {
        cmp = a.number_of_times_unanswered - b.number_of_times_unanswered;
      } else if (sortField === 'number_of_times_reviewed') {
        cmp = a.number_of_times_reviewed - b.number_of_times_reviewed;
      } else {
        cmp = a.problem_number - b.problem_number;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortField, sortDir]);

  const neverReviewed = problems.filter((p) => !p.last_reviewed).length;
  const totalMissed = problems.reduce((sum, p) => sum + p.number_of_times_unanswered, 0);

  return (
    <AuthGuard>
      <main className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-10">

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <Link
                  href="/dsa-review"
                  className="flex items-center gap-1 text-sm text-gray-500 hover:text-blue-600 transition-colors"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                  DSA Review
                </Link>
                <span className="text-gray-300">/</span>
                <h1 className="text-xl font-bold text-gray-900">Browse All Problems</h1>
              </div>
              {!loading && (
                <p className="text-sm text-gray-500">
                  {problems.length} problems · {neverReviewed} never reviewed · {totalMissed} total misses
                </p>
              )}
            </div>
            <button
              onClick={load}
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

        {/* Search & filter bar */}
        <div className="mb-4 flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by tag or number…"
              className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-4 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {/* Sort buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 font-medium shrink-0">Sort by:</span>
            <SortButton field="problem_number" label="#" currentField={sortField} currentDir={sortDir} onClick={handleSort} />
            <SortButton field="last_reviewed" label="Last reviewed" currentField={sortField} currentDir={sortDir} onClick={handleSort} />
            <SortButton field="number_of_times_unanswered" label="Misses" currentField={sortField} currentDir={sortDir} onClick={handleSort} />
            <SortButton field="number_of_times_reviewed" label="Reviews" currentField={sortField} currentDir={sortDir} onClick={handleSort} />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-xl bg-red-50 border border-red-100 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Problem list */}
        <div className="space-y-2">
          {loading
            ? Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-gray-200" />
              ))
            : sorted.length === 0
            ? (
              <div className="rounded-2xl bg-gray-50 border border-dashed border-gray-200 p-8 text-center">
                <p className="text-sm text-gray-500">
                  {problems.length === 0
                    ? 'No problems found. Add some to the review table.'
                    : 'No problems match your search.'}
                </p>
              </div>
            )
            : sorted.map((problem) => (
                <ProblemRow
                  key={problem.problem_number}
                  problem={problem}
                  onViewNotes={setModalProblem}
                />
              ))}
        </div>

        {/* Result count */}
        {!loading && sorted.length > 0 && sorted.length !== problems.length && (
          <p className="mt-3 text-xs text-gray-400 text-center">
            Showing {sorted.length} of {problems.length} problems
          </p>
        )}
      </main>

      {/* Markdown modal */}
      {modalProblem && (
        <MarkdownModal problem={modalProblem} onClose={() => setModalProblem(null)} />
      )}
    </AuthGuard>
  );
}
