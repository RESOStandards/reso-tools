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

// ── Game content: real DD 2.1 field and lookup synonyms ──
// Source: RESODataDictionary-2.1.xlsx Synonyms column.
// Field synonyms are ALWAYS disallowed — even if the standard field is present.
// Lookup synonyms must be mapped to the standard value via the Lookup Resource.

const FIELD_PAIRS: ReadonlyArray<{ readonly standard: string; readonly variation: string }> = [
  { standard: 'AccessCode', variation: 'GateCode' },
  { standard: 'ArchitecturalStyle', variation: 'Style' },
  { standard: 'AssociationFee', variation: 'HOAFee' },
  { standard: 'AssociationName', variation: 'HOAName' },
  { standard: 'AssociationYN', variation: 'HOAYN' },
  { standard: 'BathroomsFull', variation: 'FullBaths' },
  { standard: 'BathroomsHalf', variation: 'HalfBaths' },
  { standard: 'BuyerAgentFullName', variation: 'BuyerMemberFullName' },
  { standard: 'ClosePrice', variation: 'SellingPrice' },
  { standard: 'DaysOnMarket', variation: 'DOM' },
  { standard: 'DirectionFaces', variation: 'BuildingExposure' },
  { standard: 'ListAgentFullName', variation: 'ListMemberFullName' },
  { standard: 'ListingContractDate', variation: 'ListingDate' },
  { standard: 'ListingId', variation: 'MLNumber' },
  { standard: 'ListPrice', variation: 'AskingPrice' },
  { standard: 'MLSAreaMajor', variation: 'MarketingArea' },
  { standard: 'ModificationTimestamp', variation: 'ModificationDateTime' },
  { standard: 'OriginalEntryTimestamp', variation: 'EntryDate' },
  { standard: 'OriginalListPrice', variation: 'OriginalPrice' },
  { standard: 'OriginatingSystemName', variation: 'ProviderName' },
  { standard: 'PublicRemarks', variation: 'PropertyDescription' },
  { standard: 'StandardStatus', variation: 'NormalizedListingStatus' },
  { standard: 'ResourceRecordKey', variation: 'SystemUniqueID' },
  { standard: 'MemberMlsId', variation: 'AgentMlsId' },
  { standard: 'SourceSystemID', variation: 'MLSID' },
  { standard: 'PriceChangeTimestamp', variation: 'PriceChange' },
  { standard: 'TaxLegalDescription', variation: 'LegalDescription' },
  { standard: 'ListingContractDate', variation: 'ContractDate' },
  { standard: 'AssociationFee', variation: 'CAM Charge' },
  { standard: 'GrossIncome', variation: 'Actual Income' },
];

const LOOKUP_PAIRS: ReadonlyArray<{ readonly standard: string; readonly variation: string }> = [
  { standard: 'Townhouse', variation: 'Row House' },
  { standard: 'Townhouse', variation: 'Brownstone' },
  { standard: 'Exclusive Agency', variation: 'Exclusive Listing' },
  { standard: 'Active Under Contract', variation: 'Accepting Backup Offers' },
  { standard: 'Active Under Contract', variation: 'Contingent' },
  { standard: 'Pending', variation: 'Under Contract' },
  { standard: 'Condominium', variation: 'Unit' },
  { standard: 'Basement', variation: 'Cellar' },
  { standard: 'Inactive', variation: 'Terminated' },
  { standard: 'Member', variation: 'Agent' },
  { standard: 'Farm', variation: 'Farm/Ranch' },
  { standard: 'Convection Oven', variation: 'Fan-Assisted' },
  { standard: 'Call Listing Agent', variation: 'Call Listing Member' },
  { standard: 'In-Law Floorplan', variation: 'Mother In-Law Floor Plan' },
  { standard: 'Condominium', variation: 'Condo/Townhouse' },
];

const ALL_PAIRS = [...FIELD_PAIRS, ...LOOKUP_PAIRS];

const GAME_DURATION_S = 45;
const SPAWN_INTERVAL_MS = 900;
const TERM_WIDTH = 180;

const SWAT_MESSAGES = [
  'Swatted! 🪰',
  'Synonym denied! 🚫',
  'Use the standard name! ✨',
  'Variation eliminated! 💥',
  'Clean data! 🧹',
  'Not in the DD! ✅',
];

const MISS_MESSAGES = [
  'That IS the standard! 😬',
  'DD name! Penalty! ❌',
  'Check the DD first! 🛑',
  'That one was correct! 📖',
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
            Swat the synonyms! Leave DD standard names alone.
            <span className="ml-1 inline-block cursor-help" title="Field synonyms are NEVER allowed — even if the standard field is also present. Lookup synonyms must be mapped to the standard value via the Lookup Resource. All synonyms are from the DD 2.1 spreadsheet.">
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
