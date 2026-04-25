import { LexerError, ParseError, parseFilter } from '@reso-standards/odata-expression-parser';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AdvancedSearch } from '../components/advanced-search';
import { BasicSearch } from '../components/basic-search';
import { LoadingSpinner } from '../components/loading-spinner';
import { ResultsList } from '../components/results-list';
import { useCollection } from '../hooks/use-collection';
import { useMetadata } from '../hooks/use-metadata';
import { useUiConfig } from '../hooks/use-ui-config';
import { useServer } from '../context/server-context';
import { FriendlyError } from '../components/friendly-error';
import { READ_ONLY_RESOURCES } from '../types';
import { NotFoundPage } from './not-found-page';
import { getDisplayNameFromMap } from '../utils/format';

/** Map raw parser/lexer errors to a friendly explanation a non-technical user can act on. */
const humanizeFilterError = (err: ParseError | LexerError, filter: string): string => {
  const pos = err.position;
  const near = filter.slice(Math.max(0, pos - 12), Math.min(filter.length, pos + 12));
  const context = near ? ` near "…${near}…"` : '';
  const msg = err.message;

  if (err instanceof LexerError && msg.startsWith('Unterminated string')) {
    return `Looks like an unclosed quote${context}. Wrap text values in single quotes — for example, City eq 'Atlanta'.`;
  }
  if (err instanceof LexerError && msg.startsWith('Unterminated enum')) {
    return `Looks like an unclosed enum literal${context}. Enums use single quotes — for example, StandardStatus eq 'Active'.`;
  }
  if (err instanceof LexerError && msg.startsWith('Unexpected character')) {
    return `Unexpected character${context}. Check for typos, stray symbols, or characters that need to be quoted.`;
  }
  if (msg.startsWith('Empty filter')) {
    return 'The filter is empty. Try something like StandardStatus eq \'Active\'.';
  }
  if (msg.startsWith('Unexpected end of expression')) {
    return `The filter looks incomplete${context}. It may be missing a value, a closing quote, or a closing parenthesis.`;
  }
  if (msg.startsWith('Unexpected token') && msg.includes('after end of expression')) {
    return `Extra content${context} after the filter ended. You may have a stray symbol or be missing an operator like "and"/"or".`;
  }
  if (msg.startsWith('Unexpected token')) {
    return `I couldn't make sense of this part${context}. Common causes: a missing operator (eq, ne, gt, and, or), an unquoted text value, or unmatched parentheses.`;
  }
  if (msg.startsWith('Expected')) {
    return `Filter is malformed${context}. ${msg.replace(/ at position \d+$/, '.')} Check operators and matching parentheses.`;
  }
  return `Filter couldn't be parsed${context}. Make sure quotes and parens are closed, and operators are spelled correctly.`;
};

/** Search page with basic search, OData filter editor, optional advanced search, and infinite scroll results. */
export const SearchPage = () => {
  const { resource } = useParams<{ resource: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const { resources, isLoadingResources, loadingStatus, resourceError, resourceErrorUrl, permissions, activeServer, currentToken } = useServer();
  const resourceName = resource ?? '';

  const filter = searchParams.get('$filter') ?? '';
  const orderby = searchParams.get('$orderby') ?? '';
  const mode = searchParams.get('mode') ?? 'simple';
  const isAdvanced = mode === 'advanced';

  // Draft filter state — tracks what the user is composing before submitting
  const [draftFilter, setDraftFilter] = useState(filter);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Sync draft when URL filter changes (browser back/forward, initial load)
  useEffect(() => {
    setDraftFilter(filter);
    setValidationError(null);
  }, [filter]);

  const { config, fieldGroups, summaryFieldsConfig, isLoading: configLoading } = useUiConfig();
  const { fields, isLoading: metaLoading, error: metaError } = useMetadata(resourceName);

  // Resolve summary fields from config
  // Priority: server-specific config > bundled summary-fields.json > all fields
  const resourceConfig = config?.resources?.[resourceName];
  const defaultSummaryFields = summaryFieldsConfig?.[resourceName];
  const isAllFields = !resourceConfig || resourceConfig.summaryFields === '__all__';
  const summaryFields: string[] =
    !isAllFields ? [...resourceConfig.summaryFields]
    : defaultSummaryFields ? [...defaultSummaryFields]
    : fields.map(f => f.fieldName);

  // Build field lookup map for display names
  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));

  // Determine $select and $expand — use stable server context (not async fields)
  const resourceInfo = resources?.find(r => r.name === resourceName);
  const hasMediaExpansion = resourceInfo?.navigationProperties.includes('Media') ?? false;
  const selectFields = isAllFields ? undefined : summaryFields.join(',');

  // Don't fetch data until resources are discovered and token is ready for Client Credentials servers
  const needsToken = activeServer.authMode === 'client_credentials';
  const collectionReady = !isLoadingResources && (!needsToken || !!currentToken);

  const { rows, count, isLoading, hasMore, error, errorUrl, loadMore } = useCollection(resourceName, {
    $filter: filter || undefined,
    $orderby: orderby || undefined,
    $select: selectFields,
    $expand: hasMediaExpansion ? 'Media' : undefined
  }, collectionReady);
  const handleSearch = useCallback(
    (newFilter: string) => {
      const params = new URLSearchParams(searchParams);
      if (newFilter) {
        params.set('$filter', newFilter);
      } else {
        params.delete('$filter');
      }
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  /** Validate and submit the current draft filter. */
  const handleSubmit = useCallback(() => {
    const trimmed = draftFilter.trim();
    if (!trimmed) {
      setValidationError(null);
      handleSearch('');
      return;
    }
    try {
      parseFilter(trimmed);
      setValidationError(null);
      handleSearch(trimmed);
    } catch (err) {
      if (err instanceof ParseError || err instanceof LexerError) {
        setValidationError(humanizeFilterError(err, trimmed));
      } else {
        setValidationError('That filter doesn\'t look right. Check quotes, parens, and operators.');
      }
    }
  }, [draftFilter, handleSearch]);

  const handleToggleAdvanced = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    if (isAdvanced) {
      params.delete('mode');
    } else {
      params.set('mode', 'advanced');
    }
    setSearchParams(params);
  }, [searchParams, setSearchParams, isAdvanced]);

  const handleSort = useCallback(
    (field: string) => {
      const params = new URLSearchParams(searchParams);
      const currentOrder = params.get('$orderby') ?? '';
      if (currentOrder === `${field} asc`) {
        params.set('$orderby', `${field} desc`);
      } else {
        params.set('$orderby', `${field} asc`);
      }
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  const handleRowClick = useCallback(
    (key: string) => {
      navigate(`/${resourceName}/${encodeURIComponent(key)}`);
    },
    [navigate, resourceName]
  );

  // Validate resource exists in discovered metadata
  const isValidResource = resources?.some(r => r.name === resourceName) ?? null;

  if (resourceError) {
    return <FriendlyError message={resourceError} requestUrl={resourceErrorUrl ?? undefined} />;
  }
  if (isLoadingResources || isValidResource === null) {
    return <LoadingSpinner label={loadingStatus ?? 'Connecting...'} subtitle={activeServer.name} />;
  }

  if (!isValidResource) {
    return <NotFoundPage />;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Pinned toolbar — does not scroll */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-3 space-y-4 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{resourceName} Resource</h2>
          {!READ_ONLY_RESOURCES.has(resourceName) && (permissions.canAdd || permissions.canEdit || permissions.canDelete) && (
            <div className="flex gap-2">
              {permissions.canAdd && (
                <button
                  type="button"
                  onClick={() => navigate(`/${resourceName}/add`)}
                  className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700">
                  + Add
                </button>
              )}
              {permissions.canEdit && (
                <button
                  type="button"
                  onClick={() => navigate(`/${resourceName}/edit`)}
                  className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-gray-700">
                  Edit
                </button>
              )}
              {permissions.canDelete && (
                <button
                  type="button"
                  onClick={() => navigate(`/${resourceName}/delete`)}
                  className="px-3 py-1.5 text-sm border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 rounded hover:bg-red-50 dark:hover:bg-red-900/20">
                  Delete
                </button>
              )}
            </div>
          )}
        </div>

        {/* Search controls — basic search fields with Filters and OData edit */}
        <BasicSearch
          resource={resourceName}
          fields={fields}
          isLoadingFields={metaLoading || configLoading}
          rankedFieldNames={defaultSummaryFields}
          filterString={draftFilter}
          onFilterChange={setDraftFilter}
          onSearch={handleSubmit}
          onShowOData={handleToggleAdvanced}
        />

        {validationError && (
          <p
            role="alert"
            className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded px-3 py-2">
            {validationError}
          </p>
        )}

        {metaError && (
          <p
            role="alert"
            className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded px-3 py-2">
            Couldn't load metadata for this resource: {metaError}
          </p>
        )}

        {/* Sortable column headers */}
        {rows.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <span className="text-xs text-gray-500 dark:text-gray-400 mr-1">Sort by:</span>
            {[...new Set([...summaryFields.slice(0, 6), ...(fields.some(f => f.fieldName === 'ModificationTimestamp') ? ['ModificationTimestamp'] : [])])].map(f => (
              <button
                type="button"
                key={f}
                onClick={() => handleSort(f)}
                className={`text-xs px-2 py-0.5 rounded border ${
                  orderby.includes(f)
                    ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400'
                    : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}>
                {getDisplayNameFromMap(f, fieldMap)} {orderby === `${f} asc` ? '↑' : orderby === `${f} desc` ? '↓' : ''}
              </button>
            ))}
          </div>
        )}

        {/* Result count */}
        {count !== undefined && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {count.toLocaleString()} result{count !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {/* Advanced search — takes over the results area when open */}
      {isAdvanced ? (
        <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-6 py-4">
          <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm p-4">
            <AdvancedSearch
              resource={resourceName}
              fields={fields}
              fieldGroups={fieldGroups}
              filterString={draftFilter}
              onFilterChange={setDraftFilter}
              onSearch={() => {
                // Apply the filter and close advanced search in a single URL update
                const params = new URLSearchParams(searchParams);
                const trimmed = draftFilter.trim();
                if (trimmed) params.set('$filter', trimmed);
                else params.delete('$filter');
                params.delete('mode');
                setSearchParams(params);
              }}
              onClose={handleToggleAdvanced}
            />
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto min-h-0 px-4 sm:px-6 py-4 space-y-4">
        <ResultsList
          resource={resourceName}
          rows={rows}
          summaryFields={summaryFields}
          fields={fields}
          isLoading={isLoading}
          hasMore={hasMore}
          error={error}
          errorUrl={errorUrl}
          onLoadMore={loadMore}
          onRowClick={handleRowClick}
          hasMediaExpansion={hasMediaExpansion}
        />
      </div>
      )}
    </div>
  );
};
