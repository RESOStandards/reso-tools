/**
 * DD Synonym Swatter — hidden game unlocked from Open House Rush.
 *
 * Field synonyms scroll across the screen. Swat the nonstandard
 * variations (wrong names), leave the standard DD names alone.
 * Teaches RESO Data Dictionary naming conventions through play.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** A term that appears on screen. */
interface SwatterTerm {
  readonly id: number;
  readonly text: string;
  readonly isStandard: boolean;
  readonly standardName?: string;
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly swatted: boolean;
}

// ── Game content: real DD fields and their common variations ──

const FIELD_PAIRS: ReadonlyArray<{ readonly standard: string; readonly variation: string }> = [
  { standard: 'ListPrice', variation: 'Lst_Price' },
  { standard: 'ClosePrice', variation: 'Close_Price' },
  { standard: 'StreetName', variation: 'St_Name' },
  { standard: 'BathroomsTotalInteger', variation: 'Total_Baths' },
  { standard: 'BedroomsTotal', variation: 'Num_Beds' },
  { standard: 'LivingArea', variation: 'Sq_Ft' },
  { standard: 'ModificationTimestamp', variation: 'Last_Modified' },
  { standard: 'StandardStatus', variation: 'Listing_Status' },
  { standard: 'PostalCode', variation: 'Zip_Code' },
  { standard: 'City', variation: 'City_Name' },
  { standard: 'CountyOrParish', variation: 'County' },
  { standard: 'YearBuilt', variation: 'Year_Blt' },
  { standard: 'LotSizeAcres', variation: 'Lot_Acres' },
  { standard: 'GarageSpaces', variation: 'Garage_Cnt' },
  { standard: 'PropertyType', variation: 'Prop_Type' },
  { standard: 'PropertySubType', variation: 'Sub_Type' },
  { standard: 'ListAgentFullName', variation: 'Agent_Name' },
  { standard: 'BuyerAgentFullName', variation: 'Buyer_Agent' },
  { standard: 'ListOfficeName', variation: 'Office_Name' },
  { standard: 'OriginalListPrice', variation: 'Orig_Price' },
  { standard: 'DaysOnMarket', variation: 'DOM' },
  { standard: 'PublicRemarks', variation: 'Remarks' },
  { standard: 'Directions', variation: 'Dir_Text' },
  { standard: 'Latitude', variation: 'Lat' },
  { standard: 'Longitude', variation: 'Lng' },
  { standard: 'TaxAnnualAmount', variation: 'Annual_Tax' },
  { standard: 'AssociationFee', variation: 'HOA_Fee' },
  { standard: 'ListingContractDate', variation: 'Contract_Dt' },
  { standard: 'ExpirationDate', variation: 'Expire_Dt' },
  { standard: 'PhotosCount', variation: 'Num_Photos' },
];

const LOOKUP_PAIRS: ReadonlyArray<{ readonly standard: string; readonly variation: string }> = [
  { standard: 'Active', variation: 'ACT' },
  { standard: 'Pending', variation: 'PEND' },
  { standard: 'Closed', variation: 'CLS' },
  { standard: 'Single Family Residence', variation: 'SFR' },
  { standard: 'Exclusive Right To Sell', variation: 'ER' },
  { standard: 'Exclusive Agency', variation: 'EA' },
  { standard: 'Seller Reserve', variation: 'SR' },
  { standard: 'Residential', variation: 'Res' },
  { standard: 'Condominium', variation: 'Condo' },
  { standard: 'Townhouse', variation: 'TwnHse' },
  { standard: 'Mini Storage', variation: 'Mini-Storage' },
  { standard: 'Central Air', variation: 'Cntrl Air' },
  { standard: 'Forced Air', variation: 'FA' },
  { standard: 'Public Sewer', variation: 'Pub Sewer' },
  { standard: 'Well Water', variation: 'Wll Wtr' },
];

const ALL_PAIRS = [...FIELD_PAIRS, ...LOOKUP_PAIRS];

const GAME_DURATION_S = 45;
const SPAWN_INTERVAL_MS = 900;
const TERM_WIDTH = 180;

const SWAT_MESSAGES = [
  'Swatted! 🪰',
  'Standardized! ✨',
  'DD says no! 🚫',
  'Variation eliminated! 💥',
  'Clean data! 🧹',
  'RESO approved! ✅',
];

const MISS_MESSAGES = [
  'That was standard! 😬',
  'DD name! Penalty! ❌',
  'Do not swat standards! 🛑',
  'Read the spec! 📖',
];

const randomFrom = <T,>(arr: ReadonlyArray<T>): T => arr[Math.floor(Math.random() * arr.length)];

export const SynonymSwatter = ({ onClose }: { readonly onClose: () => void }) => {
  const [terms, setTerms] = useState<ReadonlyArray<SwatterTerm>>([]);
  const [score, setScore] = useState(0);
  const [misses, setMisses] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION_S);
  const [gameOver, setGameOver] = useState(false);
  const [lastMessage, setLastMessage] = useState('');
  const [streak, setStreak] = useState(0);
  const nextId = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const gameOverRef = useRef(false);
  gameOverRef.current = gameOver;

  // Timer
  useEffect(() => {
    if (gameOver) return;
    const timer = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) {
          setGameOver(true);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [gameOver]);

  // Spawn terms
  useEffect(() => {
    if (gameOver) return;
    const spawner = setInterval(() => {
      if (gameOverRef.current) return;
      const pair = randomFrom(ALL_PAIRS);
      const showStandard = Math.random() < 0.35; // 35% chance of showing the standard name
      const containerHeight = containerRef.current?.clientHeight ?? 300;
      const y = 40 + Math.random() * (containerHeight - 80);

      const term: SwatterTerm = {
        id: nextId.current++,
        text: showStandard ? pair.standard : pair.variation,
        isStandard: showStandard,
        standardName: showStandard ? undefined : pair.standard,
        x: 100,
        y,
        speed: 0.3 + Math.random() * 0.4,
        swatted: false,
      };

      setTerms(prev => [...prev, term]);
    }, SPAWN_INTERVAL_MS);
    return () => clearInterval(spawner);
  }, [gameOver]);

  // Move terms left and remove off-screen ones
  useEffect(() => {
    if (gameOver) return;
    const mover = setInterval(() => {
      setTerms(prev =>
        prev
          .map(t => t.swatted ? t : { ...t, x: t.x - t.speed })
          .filter(t => t.x > -TERM_WIDTH / 4 || t.swatted)
      );
    }, 16);
    return () => clearInterval(mover);
  }, [gameOver]);

  const handleSwat = useCallback((id: number) => {
    setTerms(prev => {
      const term = prev.find(t => t.id === id);
      if (!term || term.swatted) return prev;

      if (term.isStandard) {
        // Penalty — swatted a standard name!
        setMisses(m => m + 1);
        setStreak(0);
        setLastMessage(randomFrom(MISS_MESSAGES));
      } else {
        // Correct — swatted a variation!
        setScore(s => s + 1);
        setStreak(s => s + 1);
        setLastMessage(
          `${randomFrom(SWAT_MESSAGES)} → ${term.standardName}`
        );
      }

      return prev.map(t => t.id === id ? { ...t, swatted: true } : t);
    });
  }, []);

  const restart = useCallback(() => {
    setTerms([]);
    setScore(0);
    setMisses(0);
    setTimeLeft(GAME_DURATION_S);
    setGameOver(false);
    setLastMessage('');
    setStreak(0);
    nextId.current = 0;
  }, []);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-[540px] max-h-[90vh] overflow-hidden p-6 space-y-3">
        {/* Header */}
        <div className="text-center">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            🪰 DD Synonym Swatter
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Swat the nonstandard variations! Leave DD names alone.
            <span className="ml-1 inline-block cursor-help" title="Field synonyms are disallowed in the DD — swat them all. Lookup variations must be mapped to the standard value. Standard DD names are safe — do not swat!">
              💡
            </span>
          </p>
        </div>

        {/* Score bar */}
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-4">
            <span className="text-green-600 dark:text-green-400 tabular-nums">
              Swatted: {score}
            </span>
            <span className="text-red-500 dark:text-red-400 tabular-nums">
              Mistakes: {misses}
            </span>
            {streak >= 3 && (
              <span className="text-amber-500 tabular-nums animate-pulse">
                🔥 {streak} streak!
              </span>
            )}
          </div>
          <span className={`font-bold tabular-nums ${timeLeft <= 10 ? 'text-red-500 animate-pulse' : 'text-gray-900 dark:text-gray-100'}`}>
            {timeLeft}s
          </span>
        </div>

        {/* Timer bar */}
        <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${timeLeft <= 10 ? 'bg-red-500' : 'bg-blue-500'}`}
            style={{ width: `${(timeLeft / GAME_DURATION_S) * 100}%` }}
          />
        </div>

        {/* Game area */}
        <div
          ref={containerRef}
          className="relative h-[280px] bg-gray-50 dark:bg-gray-800/50 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700"
        >
          {/* Legend */}
          <div className="absolute top-2 left-2 flex gap-2 text-[10px] text-gray-400 dark:text-gray-500">
            <span className="px-1.5 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded">Swat variations</span>
            <span className="px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded">Leave standards</span>
          </div>

          {terms.map(term => (
            <button
              key={term.id}
              type="button"
              onClick={() => handleSwat(term.id)}
              disabled={term.swatted || gameOver}
              className={`absolute px-2 py-1 rounded-lg text-xs font-mono font-medium cursor-pointer select-none transition-all whitespace-nowrap ${
                term.swatted
                  ? term.isStandard
                    ? 'bg-red-200 dark:bg-red-900/40 text-red-700 dark:text-red-400 scale-75 opacity-50'
                    : 'bg-green-200 dark:bg-green-900/40 text-green-700 dark:text-green-400 scale-75 opacity-50'
                  : term.isStandard
                    ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-800/40 border border-green-300 dark:border-green-700'
                    : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-800/40 border border-red-300 dark:border-red-700'
              }`}
              style={{
                left: `${term.x}%`,
                top: `${term.y}px`,
                transition: term.swatted ? 'all 0.3s ease-out' : undefined,
              }}
            >
              {term.swatted && !term.isStandard ? '💥' : ''} {term.text}
            </button>
          ))}
        </div>

        {/* Message */}
        <div className="h-5 text-center">
          {lastMessage && !gameOver && (
            <p className="text-xs text-blue-600 dark:text-blue-400 font-medium animate-fade-in">
              {lastMessage}
            </p>
          )}
        </div>

        {/* Game over */}
        {gameOver && (
          <div className="text-center space-y-3 pt-1">
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {score >= 25 ? '🏆 Data Dictionary Master!' : score >= 15 ? '⭐ Standards Champion!' : score >= 8 ? '📋 Getting There!' : '📝 Read the DD Wiki!'}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              You swatted {score} variation{score !== 1 ? 's' : ''} with {misses} mistake{misses !== 1 ? 's' : ''}.
              {score > misses * 2 ? ' Clean data advocate!' : ' The DD is your friend!'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={restart}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
              >
                Play Again
              </button>
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

      <style>{`
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
