import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useServer } from '../context/server-context';
import { MediaCarousel } from './media-carousel';

interface ExpandedEntityCardProps {
  /** Navigation property name (e.g., "ListAgent", "Media"). */
  readonly title: string;
  /** Target resource type (e.g., "Member", "Media"). */
  readonly targetResource: string;
  /** Expanded entity records (1 for to-one, N for to-many). */
  readonly records: ReadonlyArray<Record<string, unknown>>;
  /** Whether this is a collection (enables pagination). */
  readonly isCollection: boolean;
}

/** Max summary fields shown per card. */
const MAX_SUMMARY_FIELDS = 6;

/** Formats a value for display without full metadata. */
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return '\u2014';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/** Returns displayable field entries from a record (excludes @odata, null, nested objects). */
const getDisplayFields = (
  record: Record<string, unknown>,
  keyField: string | undefined
): ReadonlyArray<readonly [string, string]> =>
  Object.entries(record)
    .filter(([key, value]) => {
      if (key.startsWith('@') || key === 'Media') return false;
      if (key === keyField) return false;
      if (value === null || value === undefined) return false;
      if (typeof value === 'object' && !Array.isArray(value)) return false;
      return true;
    })
    .map(([key, value]) => [key, formatValue(value)] as const);

/** Extract Media array from a record if present. */
const extractMedia = (record: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> => {
  const media = record.Media;
  if (Array.isArray(media) && media.length > 0) return media as ReadonlyArray<Record<string, unknown>>;
  return [];
};

/** Renders the summary fields for a single record with zebra striping, matching the detail page layout. */
const RecordSummary = ({
  record,
  targetResource,
  isNavigable,
  keyField,
  entityKey,
  onNavigate
}: {
  readonly record: Record<string, unknown>;
  readonly targetResource: string;
  readonly isNavigable: boolean;
  readonly keyField: string | undefined;
  readonly entityKey: unknown;
  readonly onNavigate: () => void;
}) => {
  const media = extractMedia(record);
  const displayFields = getDisplayFields(record, keyField);

  // For Media resources, treat MediaURL as a single-item media array for the thumbnail
  const isMediaResource = targetResource === 'Media';
  const mediaUrl = isMediaResource && typeof record.MediaURL === 'string' && record.MediaURL.length > 0
    ? record.MediaURL
    : undefined;

  const hasVisual = media.length > 0 || mediaUrl;

  const content = (
    <div className={`flex flex-col ${hasVisual ? 'sm:flex-row' : ''} gap-3`}>
      {/* Summary fields — left pane */}
      <div className="flex-1 min-w-0">
        {/* Key */}
        {keyField && entityKey != null && (
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">{keyField}:</span>
            <span className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate" title={String(entityKey)}>
              {String(entityKey)}
            </span>
          </div>
        )}

        {/* Zebra-striped fields */}
        <div>
          {displayFields.slice(0, MAX_SUMMARY_FIELDS).map(([key, value], idx) => {
            const stripe = idx % 2 === 1 ? 'bg-gray-100 dark:bg-gray-700/40' : '';
            return (
              <div
                key={key}
                className={`flex items-baseline gap-1 text-xs truncate px-1.5 py-0.5 rounded ${stripe}`}
                title={`${key}: ${value}`}>
                <span className="text-gray-500 dark:text-gray-400 shrink-0">{key}:</span>
                <span className="text-gray-800 dark:text-gray-200 truncate">{value}</span>
              </div>
            );
          })}
        </div>

        {displayFields.length > MAX_SUMMARY_FIELDS && (
          <span className="text-xs text-gray-400 dark:text-gray-500 mt-1 block px-1.5">
            +{displayFields.length - MAX_SUMMARY_FIELDS} more fields
          </span>
        )}
      </div>

      {/* Media carousel — right pane */}
      {media.length > 0 && (
        <div className="w-full sm:w-36 shrink-0">
          <MediaCarousel media={media} compact />
        </div>
      )}
      {media.length === 0 && mediaUrl && (
        <div className="shrink-0 w-full sm:w-36 h-24 sm:h-32 rounded overflow-hidden bg-gray-100 dark:bg-gray-700">
          <img src={mediaUrl} alt="Media thumbnail" className="w-full h-full object-cover" />
        </div>
      )}
    </div>
  );

  if (isNavigable && entityKey != null) {
    return (
      <button
        type="button"
        onClick={onNavigate}
        className="w-full text-left bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-sm transition-all p-3 cursor-pointer">
        {content}
      </button>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      {content}
    </div>
  );
};

/** Compact expansion panel for a single navigation property. Collections get prev/next pagination. */
export const ExpandedEntityCard = ({ title, targetResource, records, isCollection }: ExpandedEntityCardProps) => {
  const navigate = useNavigate();
  const { getKeyField, resources } = useServer();
  const [page, setPage] = useState(0);

  if (records.length === 0) return null;

  const isTargetNavigable = resources?.some(r => r.name === targetResource) ?? false;
  const keyField = isTargetNavigable ? getKeyField(targetResource) : undefined;

  // For collections, show one record at a time with pagination
  const currentRecord = records[page];
  const entityKey = keyField ? currentRecord[keyField] : undefined;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">
          {title}
          <span className="ml-1.5 text-xs font-normal text-gray-400 dark:text-gray-500">
            ({targetResource}{isCollection ? ` · ${records.length}` : ''})
          </span>
        </h4>

        {/* Pagination controls for collections */}
        {isCollection && records.length > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage(p => (p > 0 ? p - 1 : records.length - 1))}
              className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 text-xs"
              aria-label="Previous record">
              &larr;
            </button>
            <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
              {page + 1}/{records.length}
            </span>
            <button
              type="button"
              onClick={() => setPage(p => (p < records.length - 1 ? p + 1 : 0))}
              className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 text-xs"
              aria-label="Next record">
              &rarr;
            </button>
          </div>
        )}
      </div>

      {/* Record content */}
      <div className="p-3">
        <RecordSummary
          record={currentRecord}
          targetResource={targetResource}
          isNavigable={isTargetNavigable}
          keyField={keyField}
          entityKey={entityKey}
          onNavigate={() => {
            if (entityKey != null) navigate(`/${targetResource}/${encodeURIComponent(String(entityKey))}`);
          }}
        />
      </div>
    </div>
  );
};
