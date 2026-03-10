import type { CsdlComplexType, CsdlEnumType, CsdlNavigationProperty, CsdlSchema, FieldInfo } from '@reso-standards/odata-client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FriendlyError } from '../components/friendly-error';
import { LoadingSpinner } from '../components/loading-spinner';
import { useServer } from '../context/server-context';
import type { ResoLookup } from '../types';

/** Fetch CSDL schema, with caching handled by metadata.ts internals. */
const fetchSchema = async (baseUrl?: string, token?: string): Promise<CsdlSchema> => {
  const { parseCsdlXml } = await import('@reso-standards/odata-client');

  const isLocalhost = (url: string): boolean => {
    try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname); }
    catch { return false; }
  };
  const resolveUrl = (url: string): string =>
    !baseUrl || isLocalhost(baseUrl) ? url : `/api/proxy?url=${encodeURIComponent(url)}`;

  const rawUrl = baseUrl
    ? `${baseUrl}/$metadata?$format=application/xml`
    : '/$metadata?$format=application/xml';
  const headers: Record<string, string> = { Accept: 'application/xml' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(resolveUrl(rawUrl), { headers });
  if (!res.ok) throw new Error(`Failed to fetch $metadata: ${res.status}`);
  return parseCsdlXml(await res.text());
};

/** Badge component for field type indicators. */
const Badge = ({ label, color = 'gray' }: { readonly label: string; readonly color?: string }) => {
  const colors: Record<string, string> = {
    gray: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    green: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
  };
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors[color] ?? colors.gray}`}>{label}</span>;
};

/** Render complex type properties recursively. */
const ComplexTypeDetail = ({
  complexType,
  schema,
  depth = 0
}: {
  readonly complexType: CsdlComplexType;
  readonly schema: CsdlSchema;
  readonly depth?: number;
}) => {
  if (depth > 3) return <span className="text-xs text-gray-400 italic">nested too deep</span>;
  return (
    <div className="space-y-1">
      {complexType.properties.map(prop => {
        const typeName = prop.type.includes('.') ? prop.type.split('.').pop()! : prop.type;
        const nestedComplex = schema.complexTypes.find(ct => ct.name === typeName);
        return (
          <div key={prop.name} className="ml-4 border-l border-gray-200 dark:border-gray-600 pl-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium text-gray-800 dark:text-gray-200">{prop.name}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{prop.type}</span>
              {prop.nullable === false && <Badge label="non-nullable" color="amber" />}
            </div>
            {nestedComplex && <ComplexTypeDetail complexType={nestedComplex} schema={schema} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
  );
};

/** Inline SVG key icon for primary key badge. */
const KeyIcon = () => (
  <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
    <title>Key field</title>
    <path d="M6.5 10.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm0-1.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm3.25-1.25h4.5a.75.75 0 0 1 .53.22l1 1a.75.75 0 0 1-1.06 1.06l-.72-.72h-.72l-.72.72a.75.75 0 0 1-1.06-1.06l.22-.22H9.75a.75.75 0 0 1 0-1.5Z" />
  </svg>
);

/** Field detail expansion panel. */
const FieldDetail = ({
  field,
  schema,
  lookups,
  isKeyField,
  navProp,
  onNavigate
}: {
  readonly field: FieldInfo;
  readonly schema: CsdlSchema;
  readonly lookups: ReadonlyArray<ResoLookup>;
  readonly isKeyField: boolean;
  readonly navProp?: CsdlNavigationProperty;
  readonly onNavigate: (resource: string) => void;
}) => {
  const typeName = field.typeName ?? (field.type.includes('.') ? field.type.split('.').pop() : undefined);
  const enumType: CsdlEnumType | undefined = typeName ? schema.enumTypes.find(et => et.name === typeName) : undefined;
  const complexType: CsdlComplexType | undefined = typeName ? schema.complexTypes.find(ct => ct.name === typeName) : undefined;

  // For expansions, find the target resource
  const targetResource = field.isExpansion && typeName
    ? schema.entityContainer?.entitySets.find(es => {
        const esTypeName = es.entityType.includes('.') ? es.entityType.split('.').pop() : es.entityType;
        return esTypeName === typeName;
      })?.name
    : undefined;

  return (
    <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
      {/* Key field indicator */}
      {isKeyField && (
        <div className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
          <KeyIcon />
          <span className="font-medium">Primary Key</span>
        </div>
      )}

      {/* Type details */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <span className="text-xs text-gray-500 dark:text-gray-400 block">Type</span>
          <span className="font-mono text-gray-800 dark:text-gray-200">{field.type}</span>
        </div>
        {field.nullable !== undefined && (
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Nullable</span>
            <span className="text-gray-800 dark:text-gray-200">{field.nullable ? 'Yes' : 'No'}</span>
          </div>
        )}
        {field.maxLength !== undefined && (
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Max Length</span>
            <span className="text-gray-800 dark:text-gray-200">{field.maxLength}</span>
          </div>
        )}
        {field.precision !== undefined && (
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Precision</span>
            <span className="text-gray-800 dark:text-gray-200">{field.precision}</span>
          </div>
        )}
        {field.scale !== undefined && (
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Scale</span>
            <span className="text-gray-800 dark:text-gray-200">{field.scale}</span>
          </div>
        )}
        {field.lookupName && (
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400 block">Lookup Name</span>
            <span className="font-mono text-gray-800 dark:text-gray-200">{field.lookupName}</span>
          </div>
        )}
      </div>

      {/* Expansion link */}
      {field.isExpansion && targetResource && (
        <div>
          <span className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Navigation Target</span>
          <button
            type="button"
            onClick={() => onNavigate(targetResource)}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">
            {targetResource} {field.isCollection ? '(collection)' : '(single)'}
          </button>
        </div>
      )}

      {/* Partner navigation property */}
      {navProp?.partner && (
        <div>
          <span className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Partner Property</span>
          <span className="text-sm font-mono text-gray-800 dark:text-gray-200">{navProp.partner}</span>
        </div>
      )}

      {/* Referential constraints (foreign keys) */}
      {navProp?.referentialConstraints && navProp.referentialConstraints.length > 0 && (
        <div>
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block mb-2">Referential Constraints</span>
          <div className="space-y-1">
            {navProp.referentialConstraints.map(rc => (
              <div key={rc.property} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-gray-800 dark:text-gray-200">{rc.property}</span>
                <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <title>references</title>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                <span className="font-mono text-gray-800 dark:text-gray-200">{rc.referencedProperty}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Annotations */}
      {field.annotations.length > 0 && (
        <div>
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block mb-2">Annotations</span>
          <div className="space-y-1">
            {field.annotations.map(ann => (
              <div key={ann.term} className="flex gap-2 text-sm">
                <span className="font-mono text-gray-500 dark:text-gray-400 shrink-0">{ann.term}</span>
                <span className="text-gray-800 dark:text-gray-200 break-all">{ann.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Complex type structure */}
      {complexType && (
        <div>
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block mb-2">Complex Type: {complexType.name}</span>
          <ComplexTypeDetail complexType={complexType} schema={schema} />
        </div>
      )}

      {/* Enum members from CSDL */}
      {enumType && (
        <div>
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block mb-2">
            Enum Members ({enumType.members.length})
          </span>
          <div className="flex flex-wrap gap-1 max-h-48 overflow-y-auto">
            {enumType.members.map(m => (
              <span key={m.name} className="px-2 py-0.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded text-xs text-gray-700 dark:text-gray-300">
                {m.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Lookup Resource values (fetched) */}
      {lookups.length > 0 && !enumType && (
        <div>
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider block mb-2">
            Lookup Values ({lookups.length})
          </span>
          <div className="flex flex-wrap gap-1 max-h-48 overflow-y-auto">
            {lookups.map(l => (
              <span key={l.lookupValue} className="px-2 py-0.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded text-xs text-gray-700 dark:text-gray-300">
                {l.lookupValue}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/** Resource grid card. */
const ResourceCard = ({
  name,
  entityType,
  keyField,
  navCount,
  onClick
}: {
  readonly name: string;
  readonly entityType: string;
  readonly keyField: string;
  readonly navCount: number;
  readonly onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="text-left p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-sm transition-all">
    <div className="font-semibold text-gray-900 dark:text-gray-100">{name}</div>
    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono truncate">{entityType}</div>
    <div className="flex gap-2 mt-2">
      <Badge label={`Key: ${keyField}`} color="blue" />
      {navCount > 0 && <Badge label={`${navCount} expansions`} color="purple" />}
    </div>
  </button>
);

/** Main metadata explorer page. */
export const MetadataPage = () => {
  const { resource } = useParams<{ resource?: string }>();
  const navigate = useNavigate();
  const { resources, isLoadingResources, activeServer, isLocal } = useServer();

  const [schema, setSchema] = useState<CsdlSchema | null>(null);
  const [fields, setFields] = useState<ReadonlyArray<FieldInfo>>([]);
  const [lookups, setLookups] = useState<Readonly<Record<string, ReadonlyArray<ResoLookup>>>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Load schema on mount
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const baseUrl = isLocal ? undefined : activeServer.baseUrl;
        const s = await fetchSchema(baseUrl, activeServer.token);
        if (!cancelled) setSchema(s);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load metadata');
      }
    };
    load();
    return () => { cancelled = true; };
  }, [activeServer.id, isLocal]);

  // Load fields + lookups when resource changes
  useEffect(() => {
    if (!resource || !schema) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setExpandedField(null);
    setSearch('');
    setTypeFilter('all');

    const load = async () => {
      try {
        const { getFieldsForResource } = await import('@reso-standards/odata-client');
        const { fetchLookupsForResource } = await import('../api/metadata');
        const f = getFieldsForResource(schema, resource);
        const metaOptions = isLocal ? undefined : { baseUrl: activeServer.baseUrl, token: activeServer.token };
        const l = await fetchLookupsForResource(resource, metaOptions);
        if (!cancelled) {
          setFields(f);
          setLookups(l);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load fields');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [resource, schema, activeServer.id, isLocal]);

  const handleToggleField = useCallback((fieldName: string) => {
    setExpandedField(prev => prev === fieldName ? null : fieldName);
  }, []);

  const handleNavigateResource = useCallback((resourceName: string) => {
    navigate(`/metadata/${resourceName}`);
  }, [navigate]);

  // Filter and search
  const filteredFields = useMemo(() => {
    const lowerSearch = search.toLowerCase();
    return fields.filter(f => {
      if (lowerSearch && !f.fieldName.toLowerCase().includes(lowerSearch)) return false;
      if (typeFilter === 'properties' && f.isExpansion) return false;
      if (typeFilter === 'expansions' && !f.isExpansion) return false;
      if (typeFilter === 'enums' && !f.lookupName && !f.typeName) return false;
      return true;
    });
  }, [fields, search, typeFilter]);

  // Derive entity type info for key fields and nav props
  const entityType = useMemo(() => {
    if (!schema || !resource) return undefined;
    const entitySet = schema.entityContainer?.entitySets.find(es => es.name === resource);
    if (!entitySet) return undefined;
    const etName = entitySet.entityType.includes('.') ? entitySet.entityType.split('.').pop() : entitySet.entityType;
    return schema.entityTypes.find(et => et.name === etName);
  }, [schema, resource]);

  const keyFields = useMemo(() => new Set(entityType?.key ?? []), [entityType]);

  // Count by type for filter badges
  const typeCounts = useMemo(() => ({
    all: fields.length,
    properties: fields.filter(f => !f.isExpansion).length,
    expansions: fields.filter(f => f.isExpansion).length,
    enums: fields.filter(f => f.lookupName || (!f.isExpansion && f.typeName)).length
  }), [fields]);

  if (isLoadingResources) return <LoadingSpinner />;
  if (error && !resource) return <FriendlyError title="Metadata Error" message={error} />;

  // Resource grid view
  if (!resource) {
    return (
      <div className="h-full overflow-y-auto p-4 sm:p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Metadata Explorer</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {resources?.length ?? 0} resources available. Select one to view its fields and structure.
          </p>
        </div>

        {/* Schema stats */}
        {schema && (
          <div className="flex gap-4 mb-4 text-xs text-gray-500 dark:text-gray-400">
            <span>{schema.entityTypes.length} entity types</span>
            <span>{schema.enumTypes.length} enum types</span>
            {schema.complexTypes.length > 0 && <span>{schema.complexTypes.length} complex types</span>}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {resources?.map(r => (
            <ResourceCard
              key={r.name}
              name={r.name}
              entityType={r.entityType}
              keyField={r.keyField}
              navCount={r.navigationProperties.length}
              onClick={() => navigate(`/metadata/${r.name}`)}
            />
          ))}
        </div>

        {/* Enum types section */}
        {schema && schema.enumTypes.length > 0 && (
          <div className="mt-8">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Enum Types</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {schema.enumTypes.map(et => (
                <div key={et.name} className="p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                  <div className="font-medium text-sm text-gray-900 dark:text-gray-100">{et.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{et.members.length} members</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Complex types section */}
        {schema && schema.complexTypes.length > 0 && (
          <div className="mt-8">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Complex Types</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {schema.complexTypes.map(ct => (
                <div key={ct.name} className="p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                  <div className="font-medium text-sm text-gray-900 dark:text-gray-100">{ct.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{ct.properties.length} fields</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Field table view for a specific resource
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Pinned header */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 space-y-3">
        <button type="button" onClick={() => navigate('/metadata')} className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300">
          &larr; All resources
        </button>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{resource}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {filteredFields.length === fields.length
                ? `${fields.length} fields`
                : `${filteredFields.length} of ${fields.length} fields`}
            </p>
          </div>
        </div>

        {/* Search + filter bar */}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            placeholder="Search fields..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div className="flex gap-1">
            {(['all', 'properties', 'expansions', 'enums'] as const).map(filter => {
              const label = filter === 'properties' ? 'Fields' : filter.charAt(0).toUpperCase() + filter.slice(1);
              return (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setTypeFilter(filter)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    typeFilter === filter
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}>
                  {label} ({typeCounts[filter]})
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Scrollable field list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && <LoadingSpinner />}
        {error && <div className="p-4 text-red-600 dark:text-red-400 text-sm">{error}</div>}
        {!isLoading && !error && (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {filteredFields.map((field, idx) => {
              const isExpanded = expandedField === field.fieldName;
              const stripe = idx % 2 === 1 ? 'bg-gray-50/50 dark:bg-gray-800/30' : '';
              return (
                <div key={field.fieldName}>
                  <button
                    type="button"
                    onClick={() => handleToggleField(field.fieldName)}
                    className={`w-full text-left px-4 sm:px-6 py-2.5 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-colors cursor-pointer ${stripe}`}>
                    <div className="flex items-center gap-3">
                      {/* Expand indicator */}
                      <svg className={`w-3 h-3 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="currentColor" viewBox="0 0 20 20">
                        <title>Expand</title>
                        <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                      </svg>

                      {/* Field name + key icon */}
                      <span className="font-medium text-sm text-gray-900 dark:text-gray-100 min-w-0 truncate sm:w-64 flex items-center gap-1.5">
                        {field.fieldName}
                        {keyFields.has(field.fieldName) && (
                          <span className="text-amber-500 dark:text-amber-400" title="Primary key"><KeyIcon /></span>
                        )}
                      </span>

                      {/* Type badges */}
                      <div className="hidden sm:flex items-center gap-1.5 flex-1 min-w-0">
                        <span className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">{field.type}</span>
                        {field.isExpansion && <Badge label="expansion" color="purple" />}
                        {field.isCollection && <Badge label="collection" color="blue" />}
                        {field.lookupName && <Badge label="lookup" color="green" />}
                        {field.nullable === false && <Badge label="non-nullable" color="amber" />}
                      </div>

                      {/* Max length */}
                      {field.maxLength && (
                        <span className="hidden sm:inline text-xs text-gray-400 dark:text-gray-500">[{field.maxLength}]</span>
                      )}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && schema && (
                    <div className="px-4 sm:px-6 pb-4 pt-1">
                      <FieldDetail
                        field={field}
                        schema={schema}
                        lookups={lookups[field.fieldName] ?? []}
                        isKeyField={keyFields.has(field.fieldName)}
                        navProp={field.isExpansion ? entityType?.navigationProperties.find(np => np.name === field.fieldName) : undefined}
                        onNavigate={handleNavigateResource}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {filteredFields.length === 0 && !isLoading && (
              <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">
                No fields match your search.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
