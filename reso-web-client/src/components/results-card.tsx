import { useServer } from '../context/server-context';
import { ADDRESS_FIELDS, formatAddress, formatFieldValue, getDisplayNameFromMap, isSensitiveField } from '../utils/format';
import { MediaCarousel } from './media-carousel';
import { SensitiveValue } from './sensitive-value';

interface ResultsCardProps {
  readonly resource: string;
  readonly record: Record<string, unknown>;
  readonly summaryFields: ReadonlyArray<string>;
  readonly fieldMap: ReadonlyMap<string, import('../types').ResoField>;
  readonly onClick: (key: string) => void;
  /** Show a placeholder thumbnail when the record has no media (resource supports Media expansion). */
  readonly showMediaPlaceholder?: boolean;
}

/** Summary result card with media thumbnail and configurable fields. */
export const ResultsCard = ({ resource, record, summaryFields, fieldMap, onClick, showMediaPlaceholder = false }: ResultsCardProps) => {
  const { getKeyField } = useServer();
  const keyField = getKeyField(resource);
  const key = String(record[keyField] ?? '');
  const media = Array.isArray(record.Media) ? (record.Media as Record<string, unknown>[]) : [];

  // Build formatted address for Property resources
  const address = resource === 'Property' ? formatAddress(record) : null;

  // Show all summary fields in fixed order; hide individual address fields when a composed address is shown
  const hiddenFields = address ? ADDRESS_FIELDS : new Set<string>();
  const displayFields = summaryFields.filter(f => f !== keyField && !hiddenFields.has(f));

  return (
    <button
      type="button"
      onClick={() => onClick(key)}
      className="w-full text-left bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-sm transition-all p-3 sm:p-4 cursor-pointer">
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Media thumbnail or placeholder */}
        {media.length > 0 ? (
          <div className="w-full sm:w-36 shrink-0">
            <MediaCarousel media={media} compact />
          </div>
        ) : showMediaPlaceholder ? (
          <div className="w-full sm:w-36 shrink-0">
            <div className="relative w-full h-32 sm:h-40 rounded overflow-hidden bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
              <svg className="w-10 h-10 text-gray-300 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <title>No media</title>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          </div>
        ) : null}

        {/* Fields */}
        <div className="flex-1 min-w-0">
          {/* Key + primary info */}
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">{keyField}:</span>
            <span className="text-sm font-mono text-gray-700 dark:text-gray-300 truncate" title={key}>
              {key}
            </span>
          </div>

          {/* Address line for Property */}
          {address && (
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate mb-1" title={address}>
              {address}
            </div>
          )}

          {/* Summary fields in a responsive grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-0.5">
            {displayFields.slice(0, 9).map(fieldName => {
              const formatted = formatFieldValue(record[fieldName], fieldMap.get(fieldName));
              const sensitive = isSensitiveField(fieldName);
              return (
                <div
                  key={fieldName}
                  className="flex items-baseline gap-1 text-sm truncate"
                  title={sensitive ? getDisplayNameFromMap(fieldName, fieldMap) : `${getDisplayNameFromMap(fieldName, fieldMap)}: ${formatted}`}>
                  <span className="text-gray-500 dark:text-gray-400 shrink-0">{getDisplayNameFromMap(fieldName, fieldMap)}:</span>
                  {sensitive ? (
                    <SensitiveValue value={formatted} className="text-gray-800 dark:text-gray-200 truncate" />
                  ) : (
                    <span className="text-gray-800 dark:text-gray-200 truncate">{formatted}</span>
                  )}
                </div>
              );
            })}
          </div>

          {displayFields.length > 9 && (
            <span className="text-xs text-gray-400 dark:text-gray-500 mt-1 block">+{displayFields.length - 9} more fields</span>
          )}
        </div>
      </div>
    </button>
  );
};
