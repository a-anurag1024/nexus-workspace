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
  dateAdded?: string;
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
 * Fetch all Notion topics (paginated, full list).
 */
export async function fetchAllTopics(): Promise<Topic[]> {
  const res = await fetch(`${API_BASE_URL}/notion-review/all-topics`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch all topics: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.topics ?? []).map((t: Record<string, unknown>): Topic => ({
    id: (t.topicId as string) ?? '',
    notionPageId: (t.notionPageId as string) ?? '',
    title: (t.topicName as string) ?? '',
    subject: (t.subject as string) ?? undefined,
    notionPageUrl: (t.notionPageUrl as string) ?? undefined,
    lastReviewed: (t.lastReviewed as Topic['lastReviewed']) ?? null,
    lastQuestionsJson: (t.lastQuestionsJson as Topic['lastQuestionsJson']) ?? null,
    dateAdded: (t.dateAdded as string) ?? undefined,
  }));
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

// ---------------------------------------------------------------------------
// DSA Review
// ---------------------------------------------------------------------------

export interface DsaProblem {
  problem_number: number;
  problem_tag: string;
  leetcode_url: string;
  number_of_times_unanswered: number;
  last_reviewed: string;   // "YYYY-MM-DD" or ""
  number_of_times_reviewed: number;
}

export interface DsaProblemFull extends DsaProblem {
  summary_file: string;
}

export interface DsaTrackerDayEntry {
  problem_number: number;
  problem_tag: string;
  answered: boolean;
}

export interface DsaTrackerData {
  year: number;
  month: number;
  days: Record<string, DsaTrackerDayEntry[]>;
  reviewedDates: string[];
  totalProblemsReviewed: number;
}

export interface DsaReviewResult {
  problem_number: number;
  answered: boolean;
}

/**
 * Fetch algorithmically selected DSA problems for today's session.
 */
export async function fetchDsaSelectedProblems(): Promise<DsaProblem[]> {
  const res = await fetch(
    `${API_BASE_URL}/dsa-review/get_selected_dsa_problem_numbers`,
    { method: 'GET', headers: { 'Content-Type': 'application/json', ...authHeaders() } },
  );
  if (!res.ok) throw new Error(`Failed to fetch DSA problems: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.selected_problems ?? [];
}

/**
 * Fetch the full DSA problems table.
 */
export async function fetchDsaAllProblems(): Promise<DsaProblemFull[]> {
  const res = await fetch(
    `${API_BASE_URL}/dsa-review/fetch_dsa_review_table`,
    { method: 'GET', headers: { 'Content-Type': 'application/json', ...authHeaders() } },
  );
  if (!res.ok) throw new Error(`Failed to fetch DSA review table: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.problems ?? [];
}

/**
 * Fetch the markdown review notes for a specific DSA problem.
 */
export async function fetchDsaProblemMarkdown(
  problem_number: number,
  problem_tag: string,
): Promise<string> {
  const params = new URLSearchParams({
    problem_number: String(problem_number),
    problem_tag,
  });
  const res = await fetch(
    `${API_BASE_URL}/dsa-review/get_dsa_problem_review_markdown?${params}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json', ...authHeaders() } },
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error('No review notes found for this problem.');
    throw new Error(`Failed to fetch DSA markdown: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.markdown ?? '';
}

/**
 * Submit review results (answered/unanswered) for a session.
 */
export async function updateDsaReview(
  results: DsaReviewResult[],
  reviewed_at?: string,
): Promise<void> {
  const body: Record<string, unknown> = { results };
  if (reviewed_at) body.reviewed_at = reviewed_at;
  const res = await fetch(`${API_BASE_URL}/dsa-review/update_dsa_review_table`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 207) {
    throw new Error(`Failed to update DSA review: ${res.status} ${res.statusText}`);
  }
}

/**
 * Fetch monthly DSA review tracking data for the calendar UI.
 */
export async function fetchDsaTracker(year?: number, month?: number): Promise<DsaTrackerData> {
  const params = new URLSearchParams();
  if (year !== undefined) params.set('year', String(year));
  if (month !== undefined) params.set('month', String(month));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE_URL}/dsa-review/tracker${qs}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });
  if (!res.ok) throw new Error(`Failed to fetch DSA tracker: ${res.status} ${res.statusText}`);
  return res.json() as Promise<DsaTrackerData>;
}
