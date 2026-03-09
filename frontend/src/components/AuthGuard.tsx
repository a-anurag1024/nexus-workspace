'use client';

/**
 * AuthGuard
 *
 * Shows a single-field token prompt on first visit.  The token is saved to
 * localStorage and sent as a Bearer token on every API request.  On subsequent
 * visits (same device) the token is loaded automatically — no prompt shown.
 */

import React, { useEffect, useState } from 'react';
import { getToken, saveToken, clearToken } from '@/lib/auth';

interface AuthGuardProps {
  children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAuthenticated(getToken() !== null);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) {
      setError('Enter your access token.');
      return;
    }
    saveToken(trimmed);
    setAuthenticated(true);
  };

  const handleSignOut = () => {
    clearToken();
    setAuthenticated(false);
    setInput('');
  };

  // Checking localStorage
  if (authenticated === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  // No token – show prompt
  if (!authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
          <h1 className="mb-6 text-center text-2xl font-bold text-gray-900">
            Nexus Workspace
          </h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="token"
                className="block text-sm font-medium text-gray-700"
              >
                Access Token
              </label>
              <input
                id="token"
                type="password"
                required
                autoFocus
                value={input}
                onChange={(e) => { setInput(e.target.value); setError(null); }}
                autoComplete="current-password"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="••••••••"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Unlock
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Authenticated – render app with nav
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="flex items-center justify-between bg-white px-6 py-4 shadow-sm">
        <span className="text-lg font-semibold text-gray-900">
          Nexus Workspace
        </span>
        <button
          onClick={handleSignOut}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
        >
          Sign Out
        </button>
      </nav>
      {children}
    </div>
  );
}

