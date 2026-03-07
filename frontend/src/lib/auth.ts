/**
 * Authentication utilities – thin wrappers around aws-amplify/auth.
 */

import {
  signIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
  type AuthUser,
} from 'aws-amplify/auth';

export { signIn, signOut };

/**
 * Returns the currently authenticated user or null if no session exists.
 */
export async function getAuthUser(): Promise<AuthUser | null> {
  try {
    return await getCurrentUser();
  } catch {
    return null;
  }
}

/**
 * Returns the Cognito JWT id-token for the current session.
 * Throws if the user is not authenticated.
 */
export async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error('No id token found – user may not be authenticated.');
  }
  return token;
}

/**
 * Builds an Authorization header object containing the Bearer token.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getIdToken();
  return { Authorization: `Bearer ${token}` };
}
