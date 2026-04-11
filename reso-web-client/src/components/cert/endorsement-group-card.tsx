/**
 * Endorsement group card — one card per recipient organization with
 * each of its endorsements as a sub-row beneath an org header.
 *
 * Click semantics:
 *   - Header (org name area)  → recipient summary report
 *   - Sub-row                 → endorsement detail report
 *
 * The header is its own button rather than the entire card so the
 * nested sub-row buttons remain valid HTML.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Endorsement } from '../../api/cert-fixtures';
import { EndorsementSubRow } from './endorsement-sub-row';

interface EndorsementGroupCardProps {
  readonly recipientUoi: string;
  readonly recipientName: string;
  readonly endorsements: ReadonlyArray<Endorsement>;
  readonly isGrouped?: boolean;
  readonly onSelectGroup?: (recipientUoi: string) => void;
  readonly onSelectEndorsement?: (endorsement: Endorsement) => void;
}

const CopyableUoi = ({ uoi }: { readonly uoi: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(uoi).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied!' : `Copy ${uoi}`}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
    >
      {uoi}
      {copied ? (
        <svg className="w-3 h-3 text-green-600 dark:text-green-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42L8.5 12.08l6.79-6.79a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg className="w-3 h-3 opacity-60" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M7 3a1 1 0 011-1h7a1 1 0 011 1v10a1 1 0 01-1 1h-2v2a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h2V3zm2 4h4v6H9V7z" />
        </svg>
      )}
    </button>
  );
};

export const EndorsementGroupCard = ({
  recipientUoi,
  recipientName,
  endorsements,
  isGrouped = true,
  onSelectGroup,
  onSelectEndorsement
}: EndorsementGroupCardProps) => {
  const navigate = useNavigate();

  const handleHeaderClick = () => {
    if (onSelectGroup) {
      onSelectGroup(recipientUoi);
    } else {
      navigate(`/cert/orgs/${recipientUoi}`);
    }
  };

  return (
  <article className="bg-gray-50 dark:bg-gray-800/70 border border-gray-300/80 dark:border-gray-700/80 rounded-xl overflow-hidden shadow dark:shadow-none hover:border-gray-400 dark:hover:border-gray-600/80 hover:shadow-md dark:hover:shadow-none transition-all">
    {/* Org header — clickable, navigates to the recipient summary */}
    <button
      type="button"
      onClick={handleHeaderClick}
      className="group/header w-full flex items-center justify-between gap-4 px-5 py-3 cursor-pointer bg-gray-200 dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700 hover:bg-gray-300 dark:hover:bg-black/40 transition-colors text-left"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <svg
          className="w-4 h-4 text-gray-500 dark:text-gray-500 group-hover/header:text-blue-500 dark:group-hover/header:text-blue-400 transition-colors shrink-0"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a1 1 0 110 2H4a1 1 0 110-2V4zm3 1h2v2H7V5zm2 4H7v2h2V9zm2-4h2v2h-2V5zm2 4h-2v2h2V9z" />
        </svg>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate group-hover/header:text-blue-700 dark:group-hover/header:text-blue-300 transition-colors">
          {recipientName}
        </h3>
        <svg
          className="w-4 h-4 text-gray-500 dark:text-gray-400 group-hover/header:text-blue-600 dark:group-hover/header:text-blue-400 transition-colors shrink-0"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 010-1.06l3.71-3.71-3.71-3.71a.75.75 0 111.06-1.06l4.24 4.24a.75.75 0 010 1.06l-4.24 4.24a.75.75 0 01-1.06 0z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isGrouped && endorsements.length > 1 && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {endorsements.length} endorsement{endorsements.length === 1 ? '' : 's'}
          </span>
        )}
        <CopyableUoi uoi={recipientUoi} />
      </div>
    </button>

    {/* Endorsements */}
    <div className="divide-y divide-gray-200 dark:divide-gray-700">
      {endorsements.map((e) => (
        <EndorsementSubRow
          key={e.id}
          endorsement={e}
          onSelect={onSelectEndorsement ?? (() => navigate(`/cert/orgs/${recipientUoi}`))}
        />
      ))}
    </div>
  </article>
  );
};
