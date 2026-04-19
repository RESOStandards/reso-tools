/**
 * DD Synonym Swatter — hidden game unlocked from Open House Rush.
 *
 * Rules (matching RESO certification):
 * 1. Field synonyms (from DD Synonyms column) are NEVER allowed. Swat them.
 * 2. Everything else (cosmetic variations, lookup synonyms) is OK only if
 *    the corresponding standard name is also present. Check the metadata
 *    panel — if the standard is there, leave it. If not, swat it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface SwatterTerm {
  readonly id: number;
  readonly text: string;
  readonly type: 'field-synonym' | 'cosmetic' | 'lookup-synonym' | 'standard';
  readonly standardName: string;
  readonly standardPresent: boolean;
  readonly shouldSwat: boolean;
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly swatted: boolean;
}

// ── Field synonyms: ALWAYS disallowed (from DD 2.1 Synonyms column) ──

const FIELD_SYNONYMS: ReadonlyArray<{ readonly standard: string; readonly synonym: string }> = [
  { standard: 'AccessCode', synonym: 'GateCode' },
  { standard: 'ArchitecturalStyle', synonym: 'Style' },
  { standard: 'AssociationFee', synonym: 'HOAFee' },
  { standard: 'AssociationName', synonym: 'HOAName' },
  { standard: 'AssociationYN', synonym: 'HOAYN' },
  { standard: 'BathroomsFull', synonym: 'FullBaths' },
  { standard: 'BathroomsHalf', synonym: 'HalfBaths' },
  { standard: 'BuyerAgentFullName', synonym: 'BuyerMemberFullName' },
  { standard: 'ClosePrice', synonym: 'SellingPrice' },
  { standard: 'DaysOnMarket', synonym: 'DOM' },
  { standard: 'ListAgentFullName', synonym: 'ListMemberFullName' },
  { standard: 'ListingId', synonym: 'MLNumber' },
  { standard: 'ListPrice', synonym: 'AskingPrice' },
  { standard: 'ModificationTimestamp', synonym: 'ModificationDateTime' },
  { standard: 'OriginalListPrice', synonym: 'OriginalPrice' },
  { standard: 'PublicRemarks', synonym: 'PropertyDescription' },
  { standard: 'StandardStatus', synonym: 'NormalizedListingStatus' },
  { standard: 'MemberMlsId', synonym: 'AgentMlsId' },
  { standard: 'SourceSystemID', synonym: 'MLSID' },
  { standard: 'TaxLegalDescription', synonym: 'LegalDescription' },
];

// ── Cosmetic variations: OK only if standard is also present ──

const COSMETIC_VARIATIONS: ReadonlyArray<{ readonly standard: string; readonly variation: string }> = [
  { standard: 'BathroomsFull', variation: 'Bathrooms_Full' },
  { standard: 'BedroomsTotal', variation: 'BedroomTotal' },
  { standard: 'ListPrice', variation: 'List_Price' },
  { standard: 'ClosePrice', variation: 'Close_Price' },
  { standard: 'YearBuilt', variation: 'Year_Built' },
  { standard: 'GarageSpaces', variation: 'Garage_Spaces' },
  { standard: 'LotSizeAcres', variation: 'LotSize_Acres' },
  { standard: 'PostalCode', variation: 'Postal_Code' },
  { standard: 'PropertyType', variation: 'Property_Type' },
  { standard: 'LivingArea', variation: 'Living_Area' },
  { standard: 'PhotosCount', variation: 'PhotoCount' },
  { standard: 'StoriesTotal', variation: 'StoryTotal' },
];

// ── Lookup synonyms: OK only if StandardLookupValue is also present ──

const LOOKUP_SYNONYMS: ReadonlyArray<{ readonly standard: string; readonly synonym: string }> = [
  { standard: 'Townhouse', synonym: 'Row House' },
  { standard: 'Townhouse', synonym: 'Brownstone' },
  { standard: 'Exclusive Agency', synonym: 'Exclusive Listing' },
  { standard: 'Active Under Contract', synonym: 'Contingent' },
  { standard: 'Pending', synonym: 'Under Contract' },
  { standard: 'Condominium', synonym: 'Unit' },
  { standard: 'Basement', synonym: 'Cellar' },
  { standard: 'Inactive', synonym: 'Terminated' },
  { standard: 'Member', synonym: 'Agent' },
  { standard: 'Convection Oven', synonym: 'Fan-Assisted' },
  { standard: 'Active Under Contract', synonym: 'Backup Offer' },
  { standard: 'Condominium', synonym: 'Condo/Townhouse' },
];

// ── Standard DD names (never swat these) ──

const STANDARD_NAMES = [
  'ListPrice', 'ClosePrice', 'BathroomsFull', 'BedroomsTotal', 'YearBuilt',
  'StandardStatus', 'PostalCode', 'LivingArea', 'DaysOnMarket', 'PropertyType',
  'Pending', 'Active', 'Closed', 'Townhouse', 'Condominium', 'Residential',
  'AssociationFee', 'GarageSpaces', 'ListingId', 'ModificationTimestamp',
];

const GAME_DURATION_S = 45;
const SPAWN_INTERVAL_MS = 1100;

const CORRECT_MESSAGES = [
  'Correct! 🪰',
  'Synonym denied! 🚫',
  'Not allowed! ✨',
  'Swatted! 💥',
  'Good eye! 🧹',
];

const WRONG_SWAT_MESSAGES = [
  'That was OK! Standard is present 😬',
  'Check the metadata panel! ❌',
  'Standard was there — leave it! 🛑',
];

const WRONG_SWAT_STANDARD = [
  'That IS the standard! 😬',
  'DD name! Penalty! ❌',
  'Never swat a standard! 🛑',
];

const MISSED_MESSAGES = [
  'Should have swatted that! 👀',
  'That synonym slipped through! 🪰',
];

const randomFrom = <T,>(arr: ReadonlyArray<T>): T => arr[Math.floor(Math.random() * arr.length)];

export const SynonymSwatter = ({ onClose }: { readonly onClose: () => void }) => {
  const [terms, setTerms] = useState<ReadonlyArray<SwatterTerm>>([]);
  const [score, setScore] = useState(0);
  const [misses, setMisses] = useState(0);
  const [escaped, setEscaped] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION_S);
  const [gameOver, setGameOver] = useState(false);
  const [lastMessage, setLastMessage] = useState('');
  const [streak, setStreak] = useState(0);
  const nextId = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const gameOverRef = useRef(false);
  gameOverRef.current = gameOver;

  // Metadata context: which standards are "in the system" this round
  // Randomize on game start — some are present, some are not
  const [metadata] = useState(() => {
    const allStandards = [
      ...new Set([
        ...FIELD_SYNONYMS.map(f => f.standard),
        ...COSMETIC_VARIATIONS.map(c => c.standard),
        ...LOOKUP_SYNONYMS.map(l => l.standard),
        ...STANDARD_NAMES,
      ]),
    ];
    const present = new Set<string>();
    for (const name of allStandards) {
      if (Math.random() < 0.65) present.add(name); // 65% chance each standard is present
    }
    return present;
  });

  // Timer
  useEffect(() => {
    if (gameOver) return;
    const timer = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) { setGameOver(true); return 0; }
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
      const containerHeight = containerRef.current?.clientHeight ?? 260;
      const y = 30 + Math.random() * (containerHeight - 60);
      const roll = Math.random();

      let term: SwatterTerm;

      if (roll < 0.30) {
        // Field synonym — always swat
        const pair = randomFrom(FIELD_SYNONYMS);
        term = {
          id: nextId.current++,
          text: pair.synonym,
          type: 'field-synonym',
          standardName: pair.standard,
          standardPresent: metadata.has(pair.standard),
          shouldSwat: true, // ALWAYS
          x: 100, y, speed: 0.25 + Math.random() * 0.3, swatted: false,
        };
      } else if (roll < 0.50) {
        // Cosmetic variation — swat only if standard NOT present
        const pair = randomFrom(COSMETIC_VARIATIONS);
        const present = metadata.has(pair.standard);
        term = {
          id: nextId.current++,
          text: pair.variation,
          type: 'cosmetic',
          standardName: pair.standard,
          standardPresent: present,
          shouldSwat: !present,
          x: 100, y, speed: 0.25 + Math.random() * 0.3, swatted: false,
        };
      } else if (roll < 0.70) {
        // Lookup synonym — swat only if standard NOT present
        const pair = randomFrom(LOOKUP_SYNONYMS);
        const present = metadata.has(pair.standard);
        term = {
          id: nextId.current++,
          text: pair.synonym,
          type: 'lookup-synonym',
          standardName: pair.standard,
          standardPresent: present,
          shouldSwat: !present,
          x: 100, y, speed: 0.25 + Math.random() * 0.3, swatted: false,
        };
      } else {
        // Standard name — never swat
        const name = randomFrom(STANDARD_NAMES);
        term = {
          id: nextId.current++,
          text: name,
          type: 'standard',
          standardName: name,
          standardPresent: true,
          shouldSwat: false,
          x: 100, y, speed: 0.25 + Math.random() * 0.3, swatted: false,
        };
      }

      setTerms(prev => [...prev, term]);
    }, SPAWN_INTERVAL_MS);
    return () => clearInterval(spawner);
  }, [gameOver, metadata]);

  // Move terms and track escapes
  useEffect(() => {
    if (gameOver) return;
    const mover = setInterval(() => {
      setTerms(prev => {
        const next: SwatterTerm[] = [];
        for (const t of prev) {
          if (t.swatted) { next.push(t); continue; }
          const newX = t.x - t.speed;
          if (newX <= -10) {
            // Escaped — if it should have been swatted, that's a miss
            if (t.shouldSwat) {
              setEscaped(e => e + 1);
              setStreak(0);
              setLastMessage(randomFrom(MISSED_MESSAGES) + ` → ${t.standardName}`);
            }
            continue; // remove from list
          }
          next.push({ ...t, x: newX });
        }
        return next;
      });
    }, 16);
    return () => clearInterval(mover);
  }, [gameOver]);

  const handleSwat = useCallback((id: number) => {
    setTerms(prev => {
      const term = prev.find(t => t.id === id);
      if (!term || term.swatted) return prev;

      if (term.shouldSwat) {
        // Correct swat
        setScore(s => s + 1);
        setStreak(s => s + 1);
        const reason = term.type === 'field-synonym'
          ? `Synonym denied! → ${term.standardName}`
          : `No standard present! → needs ${term.standardName}`;
        setLastMessage(randomFrom(CORRECT_MESSAGES) + ` ${reason}`);
      } else if (term.type === 'standard') {
        // Swatted a standard name
        setMisses(m => m + 1);
        setStreak(0);
        setLastMessage(randomFrom(WRONG_SWAT_STANDARD));
      } else {
        // Swatted a variation that was OK (standard is present)
        setMisses(m => m + 1);
        setStreak(0);
        setLastMessage(randomFrom(WRONG_SWAT_MESSAGES) + ` ${term.standardName} ✓`);
      }

      return prev.map(t => t.id === id ? { ...t, swatted: true } : t);
    });
  }, []);

  const restart = useCallback(() => {
    setTerms([]);
    setScore(0);
    setMisses(0);
    setEscaped(0);
    setTimeLeft(GAME_DURATION_S);
    setGameOver(false);
    setLastMessage('');
    setStreak(0);
    nextId.current = 0;
  }, []);

  // Top metadata items to show in the sidebar
  const metadataList = [...metadata].sort().slice(0, 12);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-[680px] max-h-[90vh] overflow-hidden p-6 space-y-3">
        {/* Header */}
        <div className="text-center">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            🪰 DD Synonym Swatter
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Swat disallowed synonyms! Leave standards and valid variations alone.
            <span className="ml-1 inline-block cursor-help" title="Field synonyms (DD Synonyms column) are NEVER allowed — swat them always. Cosmetic variations and lookup synonyms are OK only if the standard name is in the metadata (check the panel on the right). Standard DD names are always safe.">
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
            <span className="text-amber-500 dark:text-amber-400 tabular-nums">
              Escaped: {escaped}
            </span>
            {streak >= 3 && (
              <span className="text-orange-500 tabular-nums animate-pulse">
                🔥 {streak}
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

        <div className="flex gap-3">
          {/* Game area */}
          <div
            ref={containerRef}
            className="relative flex-1 h-[260px] bg-gray-50 dark:bg-gray-800/50 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700"
          >
            {terms.map(term => (
              <button
                key={term.id}
                type="button"
                onClick={() => handleSwat(term.id)}
                disabled={term.swatted || gameOver}
                className={`absolute px-2 py-1 rounded-lg text-[11px] font-mono font-medium cursor-pointer select-none transition-all whitespace-nowrap ${
                  term.swatted
                    ? term.shouldSwat
                      ? 'bg-green-200 dark:bg-green-900/40 text-green-700 dark:text-green-400 scale-75 opacity-50'
                      : 'bg-red-200 dark:bg-red-900/40 text-red-700 dark:text-red-400 scale-75 opacity-50'
                    : term.type === 'standard'
                      ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700'
                      : term.type === 'field-synonym'
                        ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-800/40 border border-red-200 dark:border-red-700'
                        : 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-800/40 border border-amber-200 dark:border-amber-700'
                }`}
                style={{
                  left: `${term.x}%`,
                  top: `${term.y}px`,
                  transition: term.swatted ? 'all 0.3s ease-out' : undefined,
                }}
              >
                {term.swatted && term.shouldSwat ? '💥 ' : ''}{term.text}
              </button>
            ))}
          </div>

          {/* Metadata panel */}
          <div className="w-[140px] h-[260px] bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700 p-2 overflow-y-auto">
            <p className="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
              In Metadata
            </p>
            {metadataList.map(name => (
              <div key={name} className="text-[10px] font-mono text-green-600 dark:text-green-400 truncate py-px">
                ✓ {name}
              </div>
            ))}
            {metadata.size > 12 && (
              <div className="text-[9px] text-gray-400 mt-1">+{metadata.size - 12} more</div>
            )}
          </div>
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
              {score >= 20 && misses <= 2 ? '🏆 DD Master!' : score >= 15 ? '⭐ Standards Champion!' : score >= 8 ? '📋 Getting There!' : '📝 Study the DD!'}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Swatted {score}, {misses} mistake{misses !== 1 ? 's' : ''}, {escaped} escaped.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button type="button" onClick={restart} className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 cursor-pointer">
                Play Again
              </button>
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 cursor-pointer">
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
