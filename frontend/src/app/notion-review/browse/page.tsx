'use client';

/**
 * /app/notion-review/browse/page.tsx
 *
 * Topic Browser – displays all available Notion topics organised by subject.
 * Supports live search/filter and links directly to the Notion page.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '@/components/AuthGuard';
import { fetchAllTopics, Topic } from '@/lib/api';

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

function formatDate(value: Topic['lastReviewed'] | string | undefined): string {
  if (!value) return '—';
  const str = typeof value === 'string' ? value : (value as { start?: string }).start;
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysSince(value: Topic['lastReviewed']): number | null {
  if (!value) return null;
  const str = typeof value === 'string' ? value : (value as { start?: string }).start;
  if (!str) return null;
  return Math.floor((Date.now() - new Date(str).getTime()) / 86_400_000);
}

function lastReviewedBadge(lr: Topic['lastReviewed']): string {
  const days = daysSince(lr);
  if (days === null) return 'bg-orange-100 text-orange-700';
  if (days > 30) return 'bg-amber-100 text-amber-700';
  if (days > 14) return 'bg-yellow-100 text-yellow-700';
  return 'bg-emerald-100 text-emerald-700';
}

function lastReviewedLabel(lr: Topic['lastReviewed']): string {
  const days = daysSince(lr);
  if (days === null) return 'Never';
  if (days === 0) return 'Today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const SUBJECT_PALETTE: Record<string, { bg: string; text: string; border: string }> = {
  AI:                 { bg: 'bg-violet-50',  text: 'text-violet-700', border: 'border-violet-200' },
  'Machine Learning': { bg: 'bg-violet-50',  text: 'text-violet-700', border: 'border-violet-200' },
  Math:               { bg: 'bg-blue-50',    text: 'text-blue-700',   border: 'border-blue-200'   },
  Physics:            { bg: 'bg-cyan-50',    text: 'text-cyan-700',   border: 'border-cyan-200'   },
  Chemistry:          { bg: 'bg-teal-50',    text: 'text-teal-700',   border: 'border-teal-200'   },
  Biology:            { bg: 'bg-green-50',   text: 'text-green-700',  border: 'border-green-200'  },
  'Computer Science': { bg: 'bg-orange-50',  text: 'text-orange-700', border: 'border-orange-200' },
  Programming:        { bg: 'bg-orange-50',  text: 'text-orange-700', border: 'border-orange-200' },
  History:            { bg: 'bg-yellow-50',  text: 'text-yellow-700', border: 'border-yellow-200' },
  Economics:          { bg: 'bg-pink-50',    text: 'text-pink-700',   border: 'border-pink-200'   },
};
const DEFAULT_PALETTE = { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200' };

function subjectPalette(subject?: string) {
  return subject ? (SUBJECT_PALETTE[subject] ?? DEFAULT_PALETTE) : DEFAULT_PALETTE;
}

// ─── TopicRow ─────────────────────────────────────────────────────────────────

function TopicRow({ topic }: { topic: Topic }) {
  const palette = subjectPalette(topic.subject);
  const lastReviewedClass = lastReviewedBadge(topic.lastReviewed);
  const lastReviewedText  = lastReviewedLabel(topic.lastReviewed);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-4 py-3 shadow-sm hover:shadow-md hover:border-gray-200 transition-all">
      {/* Topic ID chip */}
      <span className="hidden sm:inline-flex shrink-0 items-center rounded-md bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-500 min-w-[52px] justify-center">
        {topic.id || '—'}
      </span>

      {/* Topic name */}
      <span className="flex-1 min-w-0 font-medium text-gray-800 truncate text-sm">
        {topic.title || <span className="italic text-gray-400">Untitled</span>}
      </span>

      {/* Date added */}
      <span className="hidden md:inline text-xs text-gray-400 shrink-0">
        Added {formatDate(topic.dateAdded)}
      </span>

      {/* Last reviewed */}
      <span className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${lastReviewedClass}`}>
        {lastReviewedText}
      </span>

      {/* Notion link */}
      {topic.notionPageUrl ? (
        <a
          href={notionHref(topic.notionPageUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className={`shrink-0 inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${palette.border} ${palette.text} ${palette.bg} hover:opacity-80`}
          title="Open in Notion"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.047.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.08.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.449-1.632z" />
          </svg>
          Notion
        </a>
      ) : (
        <span className="shrink-0 w-[72px]" />
      )}
    </div>
  );
}

// ─── SubjectGroup ─────────────────────────────────────────────────────────────

function SubjectGroup({ subject, topics }: { subject: string; topics: Topic[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const palette = subjectPalette(subject === 'Other' ? undefined : subject);

  return (
    <section>
      <button
        onClick={() => setCollapsed((c) => !c)}
        className={`w-full flex items-center justify-between rounded-xl border px-4 py-2.5 mb-2 text-left font-semibold text-sm transition-colors ${palette.bg} ${palette.border} ${palette.text} hover:opacity-90`}
      >
        <span className="flex items-center gap-2">
          <span>{subject}</span>
          <span className={`rounded-full bg-white/60 px-2 py-0.5 text-xs font-semibold ${palette.text}`}>
            {topics.length}
          </span>
        </span>
        <svg
          className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-1.5 mb-4">
          {topics.map((t) => (
            <TopicRow key={t.notionPageId || t.id} topic={t} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function BrowseContent() {
  const [topics, setTopics]     = useState<Topic[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [search, setSearch]     = useState('');
  const [subjectFilter, setSubjectFilter] = useState<string>('All');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAllTopics();
      setTopics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Unique sorted subjects
  const allSubjects = useMemo(() => {
    const s = new Set(topics.map((t) => t.subject || 'Other'));
    return ['All', ...Array.from(s).sort()];
  }, [topics]);

  // Filtered + searched topics
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return topics.filter((t) => {
      const matchSubject = subjectFilter === 'All' || (t.subject || 'Other') === subjectFilter;
      if (!matchSubject) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        (t.id || '').toLowerCase().includes(q) ||
        (t.subject || '').toLowerCase().includes(q)
      );
    });
  }, [topics, search, subjectFilter]);

  // Group by subject
  const grouped: Record<string, Topic[]> = useMemo(() => {
    const acc: Record<string, Topic[]> = {};
    for (const t of filtered) {
      const key = t.subject || 'Other';
      (acc[key] ??= []).push(t);
    }
    // Sort topics within each group by name
    for (const key of Object.keys(acc)) {
      acc[key].sort((a, b) => a.title.localeCompare(b.title));
    }
    return acc;
  }, [filtered]);

  const subjectKeys = useMemo(
    () => Object.keys(grouped).sort(),
    [grouped],
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center gap-4 flex-wrap">
          <Link
            href="/notion-review"
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Review
          </Link>

          <h1 className="text-lg font-bold text-gray-900 flex-1">Topic Browser</h1>

          {!loading && (
            <span className="text-sm text-gray-400">{topics.length} topics</span>
          )}

          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        {/* ── Search & filter bar ── */}
        <div className="mb-5 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search topics…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-4 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <select
            value={subjectFilter}
            onChange={(e) => setSubjectFilter(e.target.value)}
            className="rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-8 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          >
            {allSubjects.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* ── States ── */}
        {loading && (
          <div className="flex flex-col items-center gap-3 py-20 text-gray-400">
            <svg className="h-8 w-8 animate-spin text-indigo-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <span className="text-sm">Loading topics…</span>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            <span className="font-semibold">Error: </span>{error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="py-16 text-center text-sm text-gray-400">
            No topics match your search.
          </div>
        )}

        {/* ── Grouped topic list ── */}
        {!loading && !error && subjectKeys.length > 0 && (
          <div>
            {subjectKeys.map((subject) => (
              <SubjectGroup key={subject} subject={subject} topics={grouped[subject]} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default function BrowsePage() {
  return (
    <AuthGuard>
      <BrowseContent />
    </AuthGuard>
  );
}
