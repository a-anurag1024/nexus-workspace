'use client';

/**
 * ProgressCalendar
 *
 * A simple month-view calendar that highlights days on which at least one
 * topic was reviewed (completed).  Each completed topic is expected to carry
 * a `completedAt` ISO-date string.
 */

import React, { useMemo } from 'react';
import { Topic } from '@/lib/api';

interface ProgressCalendarProps {
  topics: Topic[];
}

type TopicWithDate = Topic & { completedAt?: string };

export default function ProgressCalendar({ topics }: ProgressCalendarProps) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  // Days in the current month
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // Week-day of the 1st (0 = Sunday)
  const startDay = new Date(year, month, 1).getDay();

  // Build a Set of day-numbers that have completed topics
  const completedDays = useMemo(() => {
    const days = new Set<number>();
    topics.forEach((t) => {
      const tw = t as TopicWithDate;
      if (t.status === 'completed' && tw.completedAt) {
        const d = new Date(tw.completedAt);
        if (d.getFullYear() === year && d.getMonth() === month) {
          days.add(d.getDate());
        }
      }
    });
    return days;
  }, [topics, year, month]);

  const monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Build grid cells
  const cells: Array<number | null> = [
    ...Array(startDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="rounded-2xl bg-white p-6 shadow">
      <h3 className="mb-4 text-base font-semibold text-gray-700">{monthLabel}</h3>
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {dayNames.map((d) => (
          <div key={d} className="pb-1 font-medium text-gray-400">
            {d}
          </div>
        ))}
        {cells.map((day, idx) => (
          <div
            key={idx}
            className={[
              'flex h-8 w-full items-center justify-center rounded-lg text-sm',
              day === null ? '' : completedDays.has(day)
                ? 'bg-indigo-600 font-semibold text-white'
                : day === now.getDate()
                  ? 'border border-indigo-400 text-indigo-600'
                  : 'text-gray-600 hover:bg-gray-100',
            ].join(' ')}
          >
            {day ?? ''}
          </div>
        ))}
      </div>
    </div>
  );
}
