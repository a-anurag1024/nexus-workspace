/**
 * API client for the Nexus backend.
 * All requests include the Cognito JWT Bearer token in the Authorization header.
 */

import { authHeaders } from './auth';
import { API_BASE_URL } from './amplify-config';

export interface Topic {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Fetch the 5 most recent Notion review topics.
 */
export async function fetchTopics(): Promise<Topic[]> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE_URL}/notion-review/topics`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch topics: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.topics as Topic[];
}

/**
 * Trigger an LLM-based review for a specific topic.
 */
export async function triggerReview(topicId: string): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE_URL}/notion-review/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ topicId }),
  });

  if (!res.ok) {
    throw new Error(`Failed to trigger review: ${res.status} ${res.statusText}`);
  }
}
