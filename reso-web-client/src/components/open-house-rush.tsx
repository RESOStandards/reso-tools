/**
 * Open House Rush — a hidden easter egg game.
 *
 * Triggered by clicking the RESO logo 5 times in quick succession.
 * Place houses on vacant lots before the open house timer runs out.
 * Pure CSS + React, no dependencies.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

const SynonymSwatter = lazy(() => import('./synonym-swatter').then(m => ({ default: m.SynonymSwatter })));

const GRID_SIZE = 5;
const GAME_DURATION_S = 30;
const SPAWN_INTERVAL_MS = 1200;

const HOUSES = ['🏠', '🏡', '🏘️', '🏚️', '🏗️'];
const SOLD = '🏠';
const LOT = '🌳';

const PUNS = [
  'Location, location, location!',
  'Great curb appeal!',
  'Move-in ready!',
  'Charming fixer-upper!',
  'Open floor plan!',
  'Close to schools!',
  'Won\'t last long!',
  'Priced to sell!',
  'Turnkey property!',
  'A real gem!',
  'Below market value!',
  'Just listed!',
  'Multiple offers expected!',
  'Needs a little TLC 🔨',
  'Starter home dreams!',
  'Perfect for investors!',
  'HOA? Never heard of her!',
  'Seller motivated!',
  'As-is, where-is!',
  'Cash only, no inspections!',
];

const randomPun = (): string => PUNS[Math.floor(Math.random() * PUNS.length)];
const randomHouse = (): string => HOUSES[Math.floor(Math.random() * HOUSES.length)];

interface Cell {
  readonly content: string;
  readonly active: boolean;
  readonly sold: boolean;
}

const makeGrid = (): ReadonlyArray<ReadonlyArray<Cell>> =>
  Array.from({ length: GRID_SIZE }, () =>
    Array.from({ length: GRID_SIZE }, () => ({
      content: LOT,
      active: false,
      sold: false,
    }))
  );

export const OpenHouseRush = ({ onClose }: { readonly onClose: () => void }) => {
  const [grid, setGrid] = useState(makeGrid);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION_S);
  const [gameOver, setGameOver] = useState(false);
  const [lastPun, setLastPun] = useState('');
  const [missed, setMissed] = useState(0);
  const [showSwatter, setShowSwatter] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const spawnRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Start the game
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          setGameOver(true);
          return 0;
        }
        return t - 1;
      });
    }, 1000);

    return () => {
      clearInterval(timerRef.current);
      clearInterval(spawnRef.current);
    };
  }, []);

  // Spawn houses on random lots
  useEffect(() => {
    if (gameOver) {
      clearInterval(spawnRef.current);
      return;
    }

    spawnRef.current = setInterval(() => {
      setGrid((prev) => {
        const next = prev.map((row) => row.map((cell) => ({ ...cell })));
        // Expire any active unsold houses (missed)
        let newMissed = 0;
        for (let r = 0; r < GRID_SIZE; r++) {
          for (let c = 0; c < GRID_SIZE; c++) {
            if (next[r][c].active && !next[r][c].sold) {
              next[r][c] = { content: LOT, active: false, sold: false };
              newMissed++;
            }
          }
        }
        if (newMissed > 0) setMissed((m) => m + newMissed);

        // Find empty lots and spawn 1-2 houses
        const empties: Array<[number, number]> = [];
        for (let r = 0; r < GRID_SIZE; r++) {
          for (let c = 0; c < GRID_SIZE; c++) {
            if (!next[r][c].active && !next[r][c].sold) empties.push([r, c]);
          }
        }

        const spawns = Math.min(1 + Math.floor(Math.random() * 2), empties.length);
        for (let i = 0; i < spawns; i++) {
          const idx = Math.floor(Math.random() * empties.length);
          const [r, c] = empties.splice(idx, 1)[0];
          next[r][c] = { content: randomHouse(), active: true, sold: false };
        }

        return next;
      });
    }, SPAWN_INTERVAL_MS);

    return () => clearInterval(spawnRef.current);
  }, [gameOver]);

  // Stop timers on game over
  useEffect(() => {
    if (gameOver) {
      clearInterval(timerRef.current);
      clearInterval(spawnRef.current);
    }
  }, [gameOver]);

  const handleClick = useCallback((r: number, c: number) => {
    if (gameOver) return;
    setGrid((prev) => {
      const cell = prev[r][c];
      if (!cell.active || cell.sold) return prev;
      const next = prev.map((row) => row.map((cl) => ({ ...cl })));
      next[r][c] = { content: SOLD, active: false, sold: true };
      return next;
    });
    setScore((s) => s + 1);
    setLastPun(randomPun());
  }, [gameOver]);

  const restart = () => {
    setGrid(makeGrid());
    setScore(0);
    setTimeLeft(GAME_DURATION_S);
    setGameOver(false);
    setLastPun('');
    setMissed(0);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              🏠 Open House Rush
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Click the houses before they leave!
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
            title="Close"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-4">
            <span className="font-bold text-green-600 dark:text-green-400 tabular-nums">
              Sold: {score}
            </span>
            <span className="text-red-500 dark:text-red-400 tabular-nums">
              Missed: {missed}
            </span>
          </div>
          <span className={`font-bold tabular-nums ${timeLeft <= 5 ? 'text-red-500 animate-pulse' : 'text-gray-900 dark:text-gray-100'}`}>
            {timeLeft}s
          </span>
        </div>

        {/* Timer bar */}
        <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${timeLeft <= 5 ? 'bg-red-500' : 'bg-green-500'}`}
            style={{ width: `${(timeLeft / GAME_DURATION_S) * 100}%` }}
          />
        </div>

        {/* Grid */}
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)` }}>
          {grid.map((row, r) =>
            row.map((cell, c) => (
              <button
                key={`${r}-${c}`}
                type="button"
                onClick={() => handleClick(r, c)}
                disabled={!cell.active || cell.sold || gameOver}
                className={`aspect-square rounded-lg text-2xl flex items-center justify-center transition-all cursor-pointer select-none ${
                  cell.sold
                    ? 'bg-green-100 dark:bg-green-900/30 scale-90'
                    : cell.active
                    ? 'bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-800/40 animate-bounce-subtle'
                    : 'bg-gray-100 dark:bg-gray-800'
                }`}
              >
                {cell.content}
              </button>
            ))
          )}
        </div>

        {/* Pun */}
        <div className="h-6 text-center">
          {lastPun && !gameOver && (
            <p className="text-xs text-amber-600 dark:text-amber-400 font-medium animate-fade-in">
              {lastPun}
            </p>
          )}
        </div>

        {/* Game over */}
        {gameOver && (
          <div className="text-center space-y-3 pt-2">
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {score >= 20 ? '🏆 Top Producer!' : score >= 10 ? '⭐ Rising Star!' : score >= 5 ? '📋 Licensed!' : '📝 Studying for the exam...'}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              You sold {score} {score === 1 ? 'house' : 'houses'} and missed {missed}.
              {score > missed ? ' Not bad, agent!' : ' The market is tough out there!'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={restart}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
              >
                Play Again
              </button>
              {score >= 5 && (
                <button
                  type="button"
                  onClick={() => setShowSwatter(true)}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 cursor-pointer animate-bounce-subtle"
                >
                  🪰 Synonym Swatter
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 cursor-pointer"
              >
                Back to Work
              </button>
            </div>
          </div>
        )}
      </div>

      {showSwatter && (
        <Suspense fallback={null}>
          <SynonymSwatter onClose={() => setShowSwatter(false)} />
        </Suspense>
      )}

      <style>{`
        @keyframes bounce-subtle {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
        .animate-bounce-subtle {
          animation: bounce-subtle 0.6s ease-in-out infinite;
        }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in {
          animation: fade-in 0.3s ease-out;
        }
      `}</style>
    </div>
  );
};
