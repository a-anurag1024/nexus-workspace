/**
 * API client for the Nexus backend.
 * All requests include the personal Bearer token from localStorage.
 */

import { authHeaders } from './auth';
import { API_BASE_URL } from './amplify-config';

export interface Topic {
  id: string;           // topicId from backend (e.g. "TOP2")
  notionPageId: string; // Notion page UUID
  title: string;
  subject?: string;
  notionPageUrl?: string;
  lastReviewed?: { start?: string; end?: string } | string | null;
  lastQuestionsJson?: string[] | string | null;
}

export interface ReviewJob {
  requestId: string;
  topicId: string;
  notionPageId?: string;
  topicName?: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  questions?: string[];
  error?: string;
}

/**
 * Fetch the 5 least-recently reviewed Notion topics.
 */
export async function fetchTopics(): Promise<Topic[]> {
  const res = await fetch(`${API_BASE_URL}/notion-review/topics`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch topics: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.topics ?? []).map((t: Record<string, unknown>): Topic => ({
    id: t.topicId ?? '',
    notionPageId: t.notionPageId ?? '',
    title: t.topicName ?? '',
    subject: t.subject ?? undefined,
    notionPageUrl: t.notionPageUrl ?? undefined,
    lastReviewed: t.lastReviewed ?? null,
    lastQuestionsJson: t.lastQuestionsJson ?? null,
  }));
}

/**
 * Trigger an LLM-based review for a specific topic.
 * Returns the requestId to poll for the generated questions.
 */
export async function triggerReview(
  topicId: string,
  notionPageId: string,
): Promise<{ requestId: string }> {
  const res = await fetch(`${API_BASE_URL}/notion-review/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ topicId, notionPageId }),
  });

  if (!res.ok) {
    throw new Error(`Failed to trigger review: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Poll for the result of a review job.
 */
export async function fetchReviewResult(requestId: string): Promise<ReviewJob> {
  const res = await fetch(
    `${API_BASE_URL}/notion-review/results/${encodeURIComponent(requestId)}`,
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch review result: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.job as ReviewJob;
}

// ---------------------------------------------------------------------------
// Review logging & tracker
// ---------------------------------------------------------------------------

export interface ReviewTopicEntry {
  notionPageId: string;
  topicId: string;
  topicName: string;
  subject?: string;
  questions?: string[];
}

export interface TrackerDayEntry {
  topicId: string;
  topicName: string;
  subject: string;
  notionPageId: string;
  questionsCount: number;
}

export interface TrackerData {
  year: number;
  month: number;
  /** Map of "YYYY-MM-DD" → list of topics reviewed that day */
  days: Record<string, TrackerDayEntry[]>;
  /** Sorted list of dates that have at least one review */
  reviewedDates: string[];
  totalTopicsReviewed: number;
}

/**
 * Log completed topic reviews.
 * Updates Notion pages and the monthly S3 tracker file.
 */
export async function logReview(
  topics: ReviewTopicEntry[],
  reviewedAt?: string,
): Promise<void> {
  const body: Record<string, unknown> = { topics };
  if (reviewedAt) body.reviewedAt = reviewedAt;

  const res = await fetch(`${API_BASE_URL}/notion-review/log-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });

  if (!res.ok && res.status !== 207) {
    throw new Error(`Failed to log review: ${res.status} ${res.statusText}`);
  }
}

/**
 * Fetch monthly review tracking data for the calendar UI.
 * Defaults to the current UTC year/month if not specified.
 */
export async function fetchTracker(year?: number, month?: number): Promise<TrackerData> {
  const params = new URLSearchParams();
  if (year !== undefined) params.set('year', String(year));
  if (month !== undefined) params.set('month', String(month));
  const qs = params.toString() ? `?${params.toString()}` : '';

  const res = await fetch(`${API_BASE_URL}/notion-review/tracker${qs}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch tracker: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<TrackerData>;
}
