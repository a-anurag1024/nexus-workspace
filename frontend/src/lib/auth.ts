/**
 * Authentication helpers.
 *
 * The personal API token is stored in localStorage after the user enters it
 * on first visit.  It is sent as a Bearer token on every API request.
 */

const TOKEN_KEY = 'nexus_api_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Returns the Authorization header, or an empty object if no token is stored. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
