'use client';

/**
 * ProgressCalendar
 *
 * GitHub-style activity heatmap that fetches review tracking data from the
 * backend. Supports 1M, 3M, 1Y, and 5Y time ranges.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { fetchTracker } from '@/lib/api';

type Range = '1M' | '3M' | '1Y' | '5Y';

const CELL = 13; // px – cell size
const GAP = 2;   // px – gap between cells

interface DayCell {
  key: string;
  count: number;
  label: string;
  isFuture: boolean;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function intensityClass(count: number, isFuture = false): string {
  if (isFuture) return 'bg-gray-50';
  if (count === 0) return 'bg-gray-100';
  if (count === 1) return 'bg-emerald-200';
  if (count <= 3) return 'bg-emerald-400';
  if (count <= 5) return 'bg-emerald-600';
  return 'bg-emerald-800';
}

function getMonthsNeeded(range: Range): Array<{ year: number; month: number }> {
  const now = new Date();
  const count = range === '1M' ? 2 : range === '3M' ? 4 : range === '1Y' ? 13 : 61;
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
): { weeks: DayCell[][]; monthLabels: Array<{ weekIdx: number; label: string }> } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Align start to Sunday of (weeksBack) weeks ago
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - today.getDay() - (weeksBack - 1) * 7);

  const weeks: DayCell[][] = [];
  const monthLabels: Array<{ weekIdx: number; label: string }> = [];
  let lastSeenMonth = -1;

  for (let w = 0; w < weeksBack; w++) {
    const week: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + w * 7 + d);

      const key = formatDate(date);
      const isFuture = date > today;
      const count = isFuture ? 0 : (daysData[key] ?? 0);

      // Track first occurrence of a new month for labels
      if (!isFuture && date.getDate() === 1 && date.getMonth() !== lastSeenMonth) {
        monthLabels.push({
          weekIdx: w,
          label: date.toLocaleString('default', { month: 'short' }),
        });
        lastSeenMonth = date.getMonth();
      }

      week.push({
        key,
        count,
        isFuture,
        label: isFuture
          ? ''
          : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}: ${count} topic${count !== 1 ? 's' : ''}`,
      });
    }
    weeks.push(week);
  }

  return { weeks, monthLabels };
}

interface MonthlyCell {
  key: string;
  count: number;
  label: string;
  isFuture: boolean;
}

function buildMonthlyGrid(daysData: Record<string, number>): MonthlyCell[][] {
  const now = new Date();
  const rows: MonthlyCell[][] = [];

  for (let yr = now.getFullYear() - 4; yr <= now.getFullYear(); yr++) {
    const row: MonthlyCell[] = [];
    for (let mo = 1; mo <= 12; mo++) {
      const prefix = `${yr}-${String(mo).padStart(2, '0')}`;
      const isFuture = yr > now.getFullYear() || (yr === now.getFullYear() && mo > now.getMonth() + 1);
      let count = 0;
      if (!isFuture) {
        for (const [date, topics] of Object.entries(daysData)) {
          if (date.startsWith(prefix)) count += topics;
        }
      }
      const monthName = new Date(yr, mo - 1).toLocaleString('default', { month: 'short' });
      row.push({ key: prefix, count, isFuture, label: `${monthName} ${yr}: ${count} topics` });
    }
    rows.push(row);
  }
  return rows;
}

interface ProgressCalendarProps {
  refreshKey?: number;
}

export default function ProgressCalendar({ refreshKey = 0 }: ProgressCalendarProps) {
  const [range, setRange] = useState<Range>('1M');
  const [daysData, setDaysData] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [totalTopics, setTotalTopics] = useState(0);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(false);
    const months = getMonthsNeeded(range);

    Promise.all(months.map(({ year, month }) => fetchTracker(year, month)))
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
        setTotalTopics(total);

        // Compute current streak (consecutive days reviewed, ending today or yesterday)
        let s = 0;
        const tod = new Date();
        tod.setHours(0, 0, 0, 0);
        for (let i = 0; i < 366; i++) {
          const d = new Date(tod);
          d.setDate(tod.getDate() - i);
          if (merged[formatDate(d)]) {
            s++;
          } else {
            break;
          }
        }
        setStreak(s);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [range, refreshKey]);

  const weeklyData = useMemo(() => {
    if (range === '5Y') return null;
    const weeksBack = range === '1M' ? 6 : range === '3M' ? 13 : 53;
    return buildWeeks(daysData, weeksBack);
  }, [range, daysData]);

  const monthlyGrid = useMemo(
    () => (range === '5Y' ? buildMonthlyGrid(daysData) : null),
    [range, daysData],
  );

  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Review Activity</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            {loading ? '…' : `${totalTopics} topics reviewed`}
            {!loading && streak > 0 && (
              <span className="ml-2 text-emerald-600 font-medium">🔥 {streak}d streak</span>
            )}
          </p>
        </div>
        {/* Range toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
          {(['1M', '3M', '1Y', '5Y'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 font-medium transition-colors ${
                range === r ? 'bg-emerald-600 text-white' : 'text-gray-500 hover:bg-gray-50'
              }`}
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
      ) : range === '5Y' && monthlyGrid ? (
        /* ── 5Y: Monthly grid ─────────────────────────────── */
        <div>
          <div className="grid grid-cols-12 gap-[2px] mb-1">
            {MONTH_LABELS.map((m) => (
              <div key={m} className="text-center text-[9px] text-gray-400">{m}</div>
            ))}
          </div>
          <div className="space-y-[2px]">
            {monthlyGrid.map((row, ri) => (
              <div key={ri} className="grid grid-cols-12 gap-[2px]">
                {row.map((cell) => (
                  <div
                    key={cell.key}
                    title={cell.label}
                    className={`h-5 rounded-sm cursor-default transition-transform hover:scale-110 ${intensityClass(cell.count, cell.isFuture)}`}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="flex mt-1">
            {Array.from({ length: 5 }, (_, i) => (
              <div
                key={i}
                className="text-[9px] text-gray-400 text-center"
                style={{ width: `${100 / 5}%` }}
              >
                {new Date().getFullYear() - 4 + i}
              </div>
            ))}
          </div>
        </div>
      ) : weeklyData ? (
        /* ── Weekly heatmap (1M / 3M / 1Y) ───────────────── */
        <div className="overflow-x-auto">
          {/* Month labels */}
          <div
            className="relative h-4 mb-0.5"
            style={{ width: `${28 + weeklyData.weeks.length * (CELL + GAP)}px` }}
          >
            {weeklyData.monthLabels.map((ml) => (
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
            {/* Day-of-week labels */}
            <div
              className="flex flex-col mr-1 shrink-0"
              style={{ gap: `${GAP}px`, width: '22px' }}
            >
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

            {/* Week columns */}
            <div className="flex" style={{ gap: `${GAP}px` }}>
              {weeklyData.weeks.map((week, wIdx) => (
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
      ) : null}

      {/* Legend */}
      <div className="mt-3 flex items-center justify-end gap-1">
        <span className="text-[9px] text-gray-400">Less</span>
        {[0, 1, 2, 4, 6].map((n) => (
          <div
            key={n}
            className={`rounded-sm ${intensityClass(n)}`}
            style={{ width: 10, height: 10 }}
          />
        ))}
        <span className="text-[9px] text-gray-400">More</span>
      </div>
    </div>
  );
}

