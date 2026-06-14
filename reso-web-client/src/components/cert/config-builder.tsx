/**
 * Certification Config Builder — provider-centric batch configuration
 * for running certification tests against multiple recipients.
 *
 * Supports all four endorsement types (DD, Core, Add/Edit, EntityEvent)
 * with per-endorsement config fields. Configs can be imported/exported
 * as JSON matching the legacy dd-config.json format.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { loadProfiles, loadConnections, saveDraft, clearDraft, type SavedCredentials, type SavedCertConfig } from '../../services/connection-manager';
import { FilterPill, Badge } from '../metadata/shared';
import { MaskedInput } from '../masked-input';
import { getOrganizations } from '../../hooks/use-organization-names';
import { useAuth } from '../../hooks/use-auth';
import { useCurrentUserSystems } from '../../hooks/use-current-user-systems';
import type { CertOrganization, CertOrganizationSystem } from '../../api/cert-client';
import {
  CURRENT_DD_VERSION,
  CERT_ENDORSEMENT_LABELS,
  CERT_ENDORSEMENT_COLORS,
  MEMORY_WARNING_THRESHOLD,
  MAX_LOCAL_CONCURRENCY,
  DEFAULT_CONCURRENCY,
} from '../../constants/cert';
import type { CertEndorsement } from '../../constants/cert';

// ── Types ────────────────────────────────────────────────────────────

type EndorsementType = CertEndorsement;
type AuthMode = 'token' | 'client_credentials';

export interface AuthTokenConfig {
  readonly mode: 'token';
  readonly authToken: string;
}

export interface ClientCredentialsConfig {
  readonly mode: 'client_credentials';
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl: string;
  readonly scope?: string;
}

export type AuthConfig = AuthTokenConfig | ClientCredentialsConfig;

interface DDOptions {
  // Free-form: the UI only lets users *select* the current version, but a
  // re-run or import can legitimately carry a past version. The server gates
  // which versions are actually supported (dd-{ver}.json existence check).
  readonly version: string;
  readonly originatingSystemName?: string;
  readonly originatingSystemId?: string;
  readonly limit?: number;
  readonly strictMode?: boolean;
  readonly batchExpand?: boolean;
  readonly requestDelay?: number;
  readonly rateLimitWait?: number;
}

interface CoreOptions {
  readonly version: '2.0.0' | '2.1.0';
  readonly resources?: string;
  readonly enumMode?: 'auto' | 'isflags' | 'collections' | 'string';
  readonly fullCoverage?: boolean;
}

interface AddEditOptions {
  readonly resource: string;
  readonly specVersion?: string;
  readonly payloadsDir?: string;
}

interface EntityEventOptions {
  readonly mode: 'observe' | 'full';
  readonly writableResource?: string;
  readonly maxEvents?: number;
  readonly pollInterval?: number;
  readonly pollTimeout?: number;
}

export interface RecipientConfig {
  readonly id: string;
  readonly description: string;
  readonly serviceRootUri: string;
  readonly recipientUoi: string;
  readonly providerUsi: string;
  readonly auth: AuthConfig;
  readonly endorsements: ReadonlyArray<EndorsementType>;
  readonly ddOptions: DDOptions;
  readonly coreOptions: CoreOptions;
  readonly addEditOptions: AddEditOptions;
  readonly entityEventOptions: EntityEventOptions;
}

export interface BatchConfig {
  readonly providerUoi: string;
  readonly concurrency: number;
  readonly recipients: ReadonlyArray<RecipientConfig>;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a RecipientConfig from a SavedCertConfig, fetching credentials from safeStorage. */
const buildRecipientFromConfig = async (
  config: SavedCertConfig,
  credentials: Map<string, SavedCredentials>,
): Promise<RecipientConfig> => {
  const conn = config.credentialsId ? credentials.get(config.credentialsId) : undefined;
  let authToken = '';
  let clientSecret = '';
  if (config.credentialsId) {
    const { getCredentials } = await import('../../services/connection-manager');
    const stored = await getCredentials(config.credentialsId);
    if (stored) {
      authToken = stored.authToken ?? '';
      clientSecret = stored.clientSecret ?? '';
    }
  }

  return {
    id: crypto.randomUUID(),
    description: config.name ?? '',
    serviceRootUri: conn?.url ?? '',
    recipientUoi: config.recipientUoi ?? '',
    providerUsi: config.providerUsi ?? '',
    auth: conn?.authMode === 'client_credentials'
      ? { mode: 'client_credentials' as const, clientId: conn.clientId ?? '', clientSecret, tokenUrl: conn.tokenUrl ?? '', scope: conn.scope }
      : { mode: 'token' as const, authToken },
    endorsements: (config.endorsements ?? ['dd']) as unknown as RecipientConfig['endorsements'],
    ddOptions: {
      version: (config.ddVersion ?? '2.1') as RecipientConfig['ddOptions']['version'],
      strictMode: config.strictMode ?? true,
      limit: config.limit,
      requestDelay: config.requestDelay,
      rateLimitWait: config.rateLimitWait,
      batchExpand: config.batchExpand,
    },
    coreOptions: { version: '2.0.0', enumMode: 'auto' },
    addEditOptions: { resource: 'Property' },
    entityEventOptions: { mode: 'observe', maxEvents: 1000, pollInterval: 5000, pollTimeout: 60000 },
  };
};

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_DD: DDOptions = { version: CURRENT_DD_VERSION, strictMode: true };
const DEFAULT_CORE: CoreOptions = { version: '2.0.0', enumMode: 'auto' };
const DEFAULT_ADD_EDIT: AddEditOptions = { resource: 'Property' };
const DEFAULT_ENTITY_EVENT: EntityEventOptions = { mode: 'observe', maxEvents: 1000, pollInterval: 5000, pollTimeout: 60000 };

const DEFAULT_AUTH: AuthConfig = { mode: 'token', authToken: '' };

const makeRecipient = (): RecipientConfig => ({
  id: crypto.randomUUID(),
  description: '',
  serviceRootUri: '',
  recipientUoi: '',
  providerUsi: '',
  auth: DEFAULT_AUTH,
  endorsements: ['dd'],
  ddOptions: DEFAULT_DD,
  coreOptions: DEFAULT_CORE,
  addEditOptions: DEFAULT_ADD_EDIT,
  entityEventOptions: DEFAULT_ENTITY_EVENT,
});

// ── Styles ───────────────────────────────────────────────────────────

const CARD = 'bg-white dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-xl';
const LABEL = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';
const INPUT = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400';
const SELECT = `${INPUT} cursor-pointer`;

// ── Endorsement labels (from shared constants) ──────────────────────

const ENDORSEMENT_LABELS = CERT_ENDORSEMENT_LABELS;

// ── Auth section ─────────────────────────────────────────────────────

const AuthSection = ({
  auth,
  onChange,
}: {
  readonly auth: AuthConfig;
  readonly onChange: (auth: AuthConfig) => void;
}) => {
  const switchMode = (mode: AuthMode) => {
    if (mode === 'token') onChange({ mode: 'token', authToken: '' });
    else onChange({ mode: 'client_credentials', clientId: '', clientSecret: '', tokenUrl: '' });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className={LABEL}>Authentication</label>
        <div className="flex items-center gap-1 ml-auto">
          <FilterPill label="Bearer Token" active={auth.mode === 'token'} onClick={() => switchMode('token')} />
          <FilterPill label="Client Credentials" active={auth.mode === 'client_credentials'} onClick={() => switchMode('client_credentials')} />
        </div>
      </div>

      {auth.mode === 'token' ? (
        <div>
          <label className={LABEL}>Auth Token</label>
          <MaskedInput
            value={auth.authToken}
            onChange={v => onChange({ ...auth, authToken: v })}
            placeholder="Bearer token"
            className={INPUT}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Client ID</label>
            <input
              type="text"
              value={auth.clientId}
              onChange={e => onChange({ ...auth, clientId: e.target.value })}
              placeholder="client_id"
              className={INPUT}
            />
          </div>
          <div>
            <label className={LABEL}>Client Secret</label>
            <MaskedInput
              value={auth.clientSecret}
              onChange={v => onChange({ ...auth, clientSecret: v })}
              placeholder="client_secret"
              className={INPUT}
            />
          </div>
          <div>
            <label className={LABEL}>Token URL</label>
            <input
              type="url"
              value={auth.tokenUrl}
              onChange={e => onChange({ ...auth, tokenUrl: e.target.value })}
              placeholder="https://auth.example.com/oauth2/token"
              className={INPUT}
            />
          </div>
          <div>
            <label className={LABEL}>Scope <span className="text-gray-400">(optional)</span></label>
            <input
              type="text"
              value={auth.scope ?? ''}
              onChange={e => onChange({ ...auth, scope: e.target.value || undefined })}
              placeholder="api"
              className={INPUT}
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ── DD options ───────────────────────────────────────────────────────

const DDOptionsSection = ({
  options,
  onChange,
}: {
  readonly options: DDOptions;
  readonly onChange: (opts: DDOptions) => void;
}) => (
  <div className="space-y-3 pt-3 border-t border-gray-100 dark:border-gray-700/50">
    <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Data Dictionary Options</p>
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
      <div>
        <label className={LABEL}>DD Version</label>
        <select value={options.version} onChange={e => onChange({ ...options, version: e.target.value })} className={SELECT}>
          <option value={CURRENT_DD_VERSION}>{CURRENT_DD_VERSION}</option>
        </select>
      </div>
      <div>
        <label className={LABEL}>Record Limit <span className="text-gray-400">(optional)</span></label>
        <input
          type="text"
          inputMode="numeric"
          value={options.limit ?? ''}
          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); onChange({ ...options, limit: v ? Number(v) : undefined }); }}
          placeholder="100000"
          className={INPUT}
        />
      </div>
      <div>
        <label className={LABEL} title="Delay between replication requests. Set to 0 for local testing. Use 1s or higher for remote servers to avoid rate limiting.">Request Delay <span className="text-gray-400">(seconds)</span></label>
        <input
          type="text"
          inputMode="decimal"
          value={options.requestDelay ?? 1}
          onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); onChange({ ...options, requestDelay: v ? Number(v) : 0 }); }}
          title="Delay between replication requests. Set to 0 for local testing."
          className={INPUT}
        />
      </div>
      <div>
        <label className={LABEL} title="How long to wait after receiving HTTP 429 Too Many Requests before retrying.">429 Wait <span className="text-gray-400">(minutes)</span></label>
        <input
          type="text"
          inputMode="numeric"
          value={options.rateLimitWait ?? 15}
          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); onChange({ ...options, rateLimitWait: v ? Number(v) : undefined }); }}
          title="Wait time after HTTP 429 Too Many Requests. Default: 15 minutes."
          className={INPUT}
        />
      </div>
      <div className="flex items-end gap-4 pb-1">
        <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={options.strictMode ?? false}
            onChange={e => onChange({ ...options, strictMode: e.target.checked })}
            className="rounded cursor-pointer"
          />
          Strict Mode
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={options.batchExpand ?? false}
            onChange={e => onChange({ ...options, batchExpand: e.target.checked })}
            className="rounded cursor-pointer"
          />
          Batch $expand
        </label>
      </div>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className={LABEL}>Originating System Name <span className="text-gray-400">(optional)</span></label>
        <input
          type="text"
          value={options.originatingSystemName ?? ''}
          onChange={e => onChange({ ...options, originatingSystemName: e.target.value || undefined })}
          placeholder="Used to filter by OriginatingSystemName"
          className={INPUT}
        />
      </div>
      <div>
        <label className={LABEL}>Originating System ID <span className="text-gray-400">(optional)</span></label>
        <input
          type="text"
          value={options.originatingSystemId ?? ''}
          onChange={e => onChange({ ...options, originatingSystemId: e.target.value || undefined })}
          placeholder="Used to filter by OriginatingSystemID"
          className={INPUT}
        />
      </div>
    </div>
  </div>
);

// ── Core options ─────────────────────────────────────────────────────

const CoreOptionsSection = ({
  options,
  onChange,
}: {
  readonly options: CoreOptions;
  readonly onChange: (opts: CoreOptions) => void;
}) => (
  <div className="space-y-3 pt-3 border-t border-gray-100 dark:border-gray-700/50">
    <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Web API Core Options</p>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div>
        <label className={LABEL}>Spec Version</label>
        <select value={options.version} onChange={e => onChange({ ...options, version: e.target.value as CoreOptions['version'] })} className={SELECT}>
          <option value="2.0.0">2.0.0</option>
          <option value="2.1.0">2.1.0</option>
        </select>
      </div>
      <div>
        <label className={LABEL}>Enum Mode</label>
        <select value={options.enumMode ?? 'auto'} onChange={e => onChange({ ...options, enumMode: e.target.value as CoreOptions['enumMode'] })} className={SELECT}>
          <option value="auto">Auto-detect</option>
          <option value="isflags">IsFlags</option>
          <option value="collections">Collections</option>
          <option value="string">String + Lookup</option>
        </select>
      </div>
      <div className="flex items-end pb-1">
        <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={options.fullCoverage ?? false}
            onChange={e => onChange({ ...options, fullCoverage: e.target.checked })}
            className="rounded cursor-pointer"
          />
          <span title="Fail if any advertised data type category (string, numeric, date, boolean, enum) is not covered by test queries">Full Coverage</span>
        </label>
      </div>
    </div>
    <div>
      <label className={LABEL}>Resources <span className="text-gray-400">(comma-separated, optional)</span></label>
      <input
        type="text"
        value={options.resources ?? ''}
        onChange={e => onChange({ ...options, resources: e.target.value || undefined })}
        placeholder="Property, Member, Office, Media, OpenHouse"
        className={INPUT}
      />
    </div>
  </div>
);

// ── Add/Edit options ─────────────────────────────────────────────────

const AddEditOptionsSection = ({
  options,
  onChange,
}: {
  readonly options: AddEditOptions;
  readonly onChange: (opts: AddEditOptions) => void;
}) => (
  <div className="space-y-3 pt-3 border-t border-gray-100 dark:border-gray-700/50">
    <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Add/Edit Options</p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className={LABEL}>Resource</label>
        <input
          type="text"
          value={options.resource}
          onChange={e => onChange({ ...options, resource: e.target.value })}
          placeholder="Property"
          className={INPUT}
        />
      </div>
      <div>
        <label className={LABEL}>Payloads Directory <span className="text-gray-400">(optional)</span></label>
        <input
          type="text"
          value={options.payloadsDir ?? ''}
          onChange={e => onChange({ ...options, payloadsDir: e.target.value || undefined })}
          placeholder="./payloads"
          className={INPUT}
        />
      </div>
    </div>
  </div>
);

// ── EntityEvent options ──────────────────────────────────────────────

const EntityEventOptionsSection = ({
  options,
  onChange,
}: {
  readonly options: EntityEventOptions;
  readonly onChange: (opts: EntityEventOptions) => void;
}) => (
  <div className="space-y-3 pt-3 border-t border-gray-100 dark:border-gray-700/50">
    <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">EntityEvent Options</p>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div>
        <label className={LABEL}>Mode</label>
        <select value={options.mode} onChange={e => onChange({ ...options, mode: e.target.value as 'observe' | 'full' })} className={SELECT}>
          <option value="observe">Observe (read-only)</option>
          <option value="full">Full (write + verify)</option>
        </select>
      </div>
      {options.mode === 'full' && (
        <div>
          <label className={LABEL}>Writable Resource</label>
          <input
            type="text"
            value={options.writableResource ?? ''}
            onChange={e => onChange({ ...options, writableResource: e.target.value || undefined })}
            placeholder="Property"
            className={INPUT}
          />
        </div>
      )}
      <div>
        <label className={LABEL}>Max Events</label>
        <input
          type="text"
          inputMode="numeric"
          value={options.maxEvents ?? ''}
          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); onChange({ ...options, maxEvents: v ? Number(v) : undefined }); }}
          placeholder="1000"
          className={INPUT}
        />
      </div>
      <div>
        <label className={LABEL}>Observe Timeout <span className="text-gray-400">(seconds)</span></label>
        <input
          type="text"
          inputMode="numeric"
          value={options.pollTimeout ? options.pollTimeout / 1000 : ''}
          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); onChange({ ...options, pollTimeout: v ? Number(v) * 1000 : undefined }); }}
          placeholder="60"
          title="How long to observe for events before stopping. Default: 60 seconds."
          className={INPUT}
        />
      </div>
    </div>
  </div>
);

// ── Shared org dropdown ──────────────────────────────────────────────

const OrgDropdown = ({
  orgs,
  search,
  onSelect,
  inline = false,
}: {
  readonly orgs: ReadonlyArray<CertOrganization>;
  readonly search: string;
  readonly onSelect: (org: CertOrganization) => void;
  readonly inline?: boolean;
}) => {
  const filtered = useMemo(() => {
    if (!search.trim()) return orgs.slice(0, 20);
    const query = search.toLowerCase();
    return orgs.filter(o =>
      o.name.toLowerCase().includes(query) || o.id.toLowerCase().includes(query)
    ).slice(0, 20);
  }, [orgs, search]);

  if (filtered.length === 0) return null;

  return (
    <div className={inline ? '' : 'absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto'}>
      {filtered.map(org => (
        <button
          key={org.id}
          type="button"
          onMouseDown={e => { e.preventDefault(); onSelect(org); }}
          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
        >
          <span className="font-medium text-gray-900 dark:text-gray-100">{org.name}</span>
          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500 font-mono">{org.id}</span>
        </button>
      ))}
    </div>
  );
};

// ── Recipient card ───────────────────────────────────────────────────

const RecipientCard = ({
  recipient,
  index,
  onChange,
  onRemove,
  onDuplicate,
  orgs,
  providerSystems,
  matchConfigs,
  savedCredentials,
}: {
  readonly recipient: RecipientConfig;
  readonly index: number;
  readonly onChange: (r: RecipientConfig) => void;
  readonly onRemove: () => void;
  readonly onDuplicate: () => void;
  readonly orgs: ReadonlyArray<CertOrganization>;
  readonly matchConfigs: (query: string) => ReadonlyArray<SavedCertConfig>;
  readonly savedCredentials: Map<string, SavedCredentials>;
  readonly providerSystems: ReadonlyArray<CertOrganizationSystem>;
}) => {
  const [expanded, setExpanded] = useState(true);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [showRecipientDropdown, setShowRecipientDropdown] = useState(false);
  const [recipientName, setRecipientName] = useState(() => {
    if (recipient.description) return recipient.description;
    if (recipient.recipientUoi) {
      const match = orgs.find(o => o.id === recipient.recipientUoi);
      if (match) return match.name;
    }
    return '';
  });

  // Resolve recipient name when orgs load (they may arrive after initial render)
  useEffect(() => {
    if (recipientName || !recipient.recipientUoi || orgs.length === 0) return;
    const match = orgs.find(o => o.id === recipient.recipientUoi);
    if (match) setRecipientName(match.name);
  }, [orgs, recipient.recipientUoi, recipientName]);

  const [endorsementWarning, setEndorsementWarning] = useState('');

  const toggleEndorsement = (type: EndorsementType) => {
    const current = recipient.endorsements;
    const adding = !current.includes(type);
    const next = adding ? [...current, type] : current.filter(e => e !== type);

    // Warn if both Add/Edit and EntityEvent (observe) are selected
    if (adding) {
      const eeObserve = recipient.entityEventOptions.mode === 'observe';
      if (type === 'add-edit' && next.includes('entity-event') && eeObserve) {
        setEndorsementWarning('EntityEvent in observe mode should run separately from Add/Edit. Run Add/Edit first, then EntityEvent observe in a separate job so there are events to detect.');
        return;
      }
      if (type === 'entity-event' && next.includes('add-edit') && eeObserve) {
        setEndorsementWarning('EntityEvent in observe mode should run separately from Add/Edit. Run Add/Edit first, then EntityEvent observe in a separate job so there are events to detect.');
        return;
      }
    }

    setEndorsementWarning('');
    onChange({ ...recipient, endorsements: next });
  };

  return (
    <div className={`${CARD} overflow-hidden`}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 cursor-pointer"
        >
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
          </svg>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {recipient.description || recipient.recipientUoi || `Recipient ${index + 1}`}
          </span>
          <div className="flex items-center gap-1 ml-2">
            {recipient.endorsements.map(e => (
              <Badge key={e} label={ENDORSEMENT_LABELS[e]} color={CERT_ENDORSEMENT_COLORS[e]} />
            ))}
          </div>
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDuplicate}
            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
            title="Duplicate"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
              <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-1.5 text-gray-400 hover:text-red-500 cursor-pointer"
            title="Remove"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="p-4 space-y-4">
          {/* Recipient org + system + server */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Recipient org picker */}
            <div className="relative">
              <label className={LABEL}>Recipient</label>
              {recipient.recipientUoi ? (
                <div className={`${INPUT} flex items-center justify-between`}>
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{recipientName || recipient.recipientUoi}</span>
                    <span className="ml-2 text-xs text-gray-400 dark:text-gray-500 font-mono">{recipient.recipientUoi}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { onChange({ ...recipient, recipientUoi: '', description: '' }); setRecipientName(''); }}
                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer shrink-0 ml-2"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                    </svg>
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    value={recipientSearch}
                    onChange={e => { setRecipientSearch(e.target.value); setShowRecipientDropdown(true); }}
                    onFocus={() => setShowRecipientDropdown(true)}
                    onBlur={() => setTimeout(() => setShowRecipientDropdown(false), 200)}
                    placeholder="Search recipient by name or UOI..."
                    className={INPUT}
                  />
                  {showRecipientDropdown && (
                    <div className="absolute z-20 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {matchConfigs(recipientSearch).length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800/80">
                            Saved Configs
                          </div>
                          {matchConfigs(recipientSearch).map(config => (
                            <button
                              key={config.id}
                              type="button"
                              className="w-full px-3 py-2 text-left hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer"
                              onMouseDown={e => {
                                e.preventDefault();
                                buildRecipientFromConfig(config, savedCredentials).then(built => {
                                  onChange({ ...built, id: recipient.id });
                                  setRecipientName(config.recipientName ?? config.name ?? '');
                                  setRecipientSearch('');
                                  setShowRecipientDropdown(false);
                                });
                              }}
                            >
                              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{config.name || config.recipientName || config.recipientUoi}</div>
                              <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{savedCredentials.get(config.credentialsId ?? '')?.url ?? config.recipientUoi}</div>
                            </button>
                          ))}
                        </>
                      )}
                      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800/80">
                        Organizations
                      </div>
                      <OrgDropdown
                        orgs={orgs}
                        search={recipientSearch}
                        onSelect={org => {
                          onChange({ ...recipient, recipientUoi: org.id, description: org.name });
                          setRecipientName(org.name);
                          setRecipientSearch('');
                          setShowRecipientDropdown(false);
                        }}
                        inline
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Provider system (USI) — per recipient */}
            <div>
              <label className={LABEL}>Provider System (USI)</label>
              {providerSystems.length > 0 ? (
                <select
                  value={recipient.providerUsi}
                  onChange={e => onChange({ ...recipient, providerUsi: e.target.value })}
                  className={SELECT}
                >
                  <option value="">Select a system...</option>
                  {providerSystems.map(s => (
                    <option key={s.usi} value={s.usi}>{s.systemName} ({s.usi})</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={recipient.providerUsi}
                  onChange={e => onChange({ ...recipient, providerUsi: e.target.value })}
                  placeholder="System identifier"
                  className={INPUT}
                />
              )}
            </div>

            {/* Server URL */}
            <div className="sm:col-span-2">
              <label className={LABEL}>Server URL</label>
              <input
                type="url"
                value={recipient.serviceRootUri}
                onChange={e => onChange({ ...recipient, serviceRootUri: e.target.value })}
                placeholder="https://api.example.com/odata"
                className={INPUT}
              />
            </div>
          </div>

          {/* Auth */}
          <AuthSection auth={recipient.auth} onChange={auth => onChange({ ...recipient, auth })} />

          {/* Endorsement toggles */}
          <div className="space-y-2">
            <label className={LABEL}>Endorsements</label>
            <div className="flex items-center gap-2 flex-wrap">
              {(Object.entries(ENDORSEMENT_LABELS) as ReadonlyArray<[EndorsementType, string]>).map(([type, label]) => (
                <label key={type} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={recipient.endorsements.includes(type)}
                    onChange={() => toggleEndorsement(type)}
                    className="rounded cursor-pointer"
                  />
                  {label}
                </label>
              ))}
            </div>
            {endorsementWarning && (
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1 mt-1">
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
                {endorsementWarning}
              </p>
            )}
          </div>

          {/* Per-endorsement options */}
          {recipient.endorsements.includes('dd') && (
            <DDOptionsSection options={recipient.ddOptions} onChange={ddOptions => onChange({ ...recipient, ddOptions })} />
          )}
          {recipient.endorsements.includes('core') && (
            <CoreOptionsSection options={recipient.coreOptions} onChange={coreOptions => onChange({ ...recipient, coreOptions })} />
          )}
          {recipient.endorsements.includes('add-edit') && (
            <AddEditOptionsSection options={recipient.addEditOptions} onChange={addEditOptions => onChange({ ...recipient, addEditOptions })} />
          )}
          {recipient.endorsements.includes('entity-event') && (
            <EntityEventOptionsSection options={recipient.entityEventOptions} onChange={entityEventOptions => onChange({ ...recipient, entityEventOptions })} />
          )}
        </div>
      )}
    </div>
  );
};

// ── Main Config Builder ──────────────────────────────────────────────

export const ConfigBuilder = ({
  onClose,
  onStart,
  onSave,
  initialConfig,
  savedConfigId,
  savedConfigName,
  refreshKey,
}: {
  readonly onClose: () => void;
  readonly onStart: (config: BatchConfig) => void;
  readonly onSave?: (config: BatchConfig, existingId?: string, name?: string) => void;
  readonly initialConfig?: BatchConfig;
  readonly savedConfigId?: string | null;
  readonly savedConfigName?: string | null;
  readonly refreshKey?: number;
}) => {
  const { user, isAdmin } = useAuth();
  // When a provider account is signed in, the cert config's provider
  // identity is locked to their org — they can't run jobs on behalf of
  // anyone else. Admins (and signed-out sessions) keep the open picker.
  const lockedProviderUoi = !isAdmin ? user?.providerUoi ?? null : null;
  const { systems: lockedSystems } = useCurrentUserSystems();

  const [providerUoi, setProviderUoi] = useState(
    lockedProviderUoi ?? initialConfig?.providerUoi ?? '',
  );
  const [providerName, setProviderName] = useState('');
  const [providerSystems, setProviderSystems] = useState<ReadonlyArray<CertOrganizationSystem>>([]);
  const [concurrency, setConcurrency] = useState(initialConfig?.concurrency ?? DEFAULT_CONCURRENCY);
  const [recipients, setRecipients] = useState<ReadonlyArray<RecipientConfig>>(
    initialConfig?.recipients ?? [makeRecipient()]
  );

  // Org directory for provider/recipient pickers
  const [orgs, setOrgs] = useState<ReadonlyArray<CertOrganization>>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [providerSearch, setProviderSearch] = useState('');
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);
  const [highlightedOrgIndex, setHighlightedOrgIndex] = useState(-1);

  // Saved cert configs for autocomplete
  const [savedConfigs, setSavedConfigs] = useState<ReadonlyArray<SavedCertConfig>>([]);
  const [savedCredentials, setSavedCredentials] = useState<Map<string, SavedCredentials>>(new Map());

  useEffect(() => {
    setOrgsLoading(true);
    getOrganizations(null)
      .then(loaded => {
        setOrgs(loaded);
        // Resolve provider name from org directory if we have a UOI but no name
        if (providerUoi && !providerName) {
          const match = loaded.find(o => o.id === providerUoi);
          if (match) {
            setProviderName(match.name);
            setProviderSystems(match.systems ?? []);
          }
        }
      })
      .catch(() => {})
      .finally(() => setOrgsLoading(false));

  }, []);

  // Provider lock — when a non-admin user is signed in, force the
  // form's providerUoi to their org and use the cert API's systems
  // list as the source of truth for USIs. Imports / saved configs
  // that arrive with a different providerUoi get rewritten silently.
  useEffect(() => {
    if (!lockedProviderUoi) return;
    if (providerUoi !== lockedProviderUoi) setProviderUoi(lockedProviderUoi);
  }, [lockedProviderUoi, providerUoi]);

  useEffect(() => {
    if (!lockedProviderUoi) return;
    setProviderSystems(lockedSystems);
  }, [lockedProviderUoi, lockedSystems]);

  // Load saved cert configs and credentials for autocomplete (refreshes after save)
  useEffect(() => {
    loadProfiles().then(setSavedConfigs).catch(() => {});
    loadConnections().then(conns => setSavedCredentials(new Map(conns.map(c => [c.id, c])))).catch(() => {});
  }, [refreshKey]);

  // Autosave draft on unmount / beforeunload (replaces blocker which breaks Electron quit)
  const draftRef = useRef({ providerUoi, concurrency, recipients, savedConfigId, savedConfigName });
  draftRef.current = { providerUoi, concurrency, recipients, savedConfigId, savedConfigName };

  useEffect(() => {
    const saveOnUnload = () => {
      const { providerUoi: pUoi, concurrency: conc, recipients: recs, savedConfigId: cId, savedConfigName: cName } = draftRef.current;
      // Only save if there's meaningful content
      if (pUoi || recs.some(r => r.recipientUoi || r.serviceRootUri)) {
        saveDraft({ config: { providerUoi: pUoi, concurrency: conc, recipients: recs }, configId: cId ?? null, configName: cName ?? null }).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', saveOnUnload);
    return () => {
      window.removeEventListener('beforeunload', saveOnUnload);
      saveOnUnload(); // Also save on component unmount (navigation away)
    };
  }, []);

  /** Filter saved cert configs by a search query, or return MRU 3 when empty. */
  const matchConfigs = useCallback((query: string): ReadonlyArray<SavedCertConfig> => {
    const sorted = [...savedConfigs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!query || query.length < 2) return sorted.slice(0, 3);
    const q = query.toLowerCase();
    return sorted.filter(c => {
      const conn = c.credentialsId ? savedCredentials.get(c.credentialsId) : undefined;
      return [c.name, conn?.url, c.providerUoi, c.providerName, c.providerUsi, c.systemName, c.recipientUoi, c.recipientName]
        .filter(Boolean)
        .some(field => field!.toLowerCase().includes(q));
    }).slice(0, 8);
  }, [savedConfigs, savedCredentials]);

  const selectProvider = useCallback((org: CertOrganization) => {
    setProviderUoi(org.id);
    setProviderName(org.name);
    setProviderSearch('');
    setShowProviderDropdown(false);
    setProviderSystems(org.systems ?? []);
  }, []);

  const updateRecipient = useCallback((index: number, updated: RecipientConfig) => {
    setRecipients(prev => prev.map((r, i) => i === index ? updated : r));
  }, []);

  const removeRecipient = useCallback((index: number) => {
    setRecipients(prev => prev.filter((_, i) => i !== index));
  }, []);

  const duplicateRecipient = useCallback((index: number) => {
    setRecipients(prev => {
      const copy = { ...prev[index], id: crypto.randomUUID(), description: `${prev[index].description} (copy)` };
      return [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)];
    });
  }, []);

  const addRecipient = () => setRecipients(prev => [...prev, makeRecipient()]);

  const totalJobs = recipients.reduce((sum, r) => sum + r.endorsements.length, 0);

  const handleExport = () => {
    const config: BatchConfig = { providerUoi, concurrency, recipients };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cert-config.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        // Support both legacy dd-config format and our BatchConfig format
        if ('providerUoi' in parsed && typeof parsed.providerUoi === 'string') {
          setProviderUoi(parsed.providerUoi);
        }
        if ('concurrency' in parsed && typeof parsed.concurrency === 'number') {
          setConcurrency(parsed.concurrency);
        }
        if ('recipients' in parsed && Array.isArray(parsed.recipients)) {
          setRecipients(parsed.recipients as ReadonlyArray<RecipientConfig>);
        } else if ('configs' in parsed && Array.isArray(parsed.configs)) {
          // Legacy dd-config format
          const legacyConfigs = parsed.configs as ReadonlyArray<Record<string, unknown>>;
          const imported: ReadonlyArray<RecipientConfig> = legacyConfigs.map(c => ({
            id: crypto.randomUUID(),
            description: (c.description as string) ?? '',
            serviceRootUri: (c.serviceRootUri as string) ?? '',
            recipientUoi: (c.recipientUoi as string) ?? '',
            providerUsi: (c.providerUsi as string) ?? '',
            auth: c.token
              ? { mode: 'token' as const, authToken: c.token as string }
              : c.clientCredentials
              ? {
                  mode: 'client_credentials' as const,
                  clientId: (c.clientCredentials as Record<string, string>).clientId ?? '',
                  clientSecret: (c.clientCredentials as Record<string, string>).clientSecret ?? '',
                  tokenUrl: (c.clientCredentials as Record<string, string>).tokenUri ?? '',
                  scope: (c.clientCredentials as Record<string, string>).scope,
                }
              : DEFAULT_AUTH,
            endorsements: ['dd'],
            ddOptions: {
              ...DEFAULT_DD,
              originatingSystemName: c.originatingSystemName as string | undefined,
              originatingSystemId: c.originatingSystemId as string | undefined,
            },
            coreOptions: DEFAULT_CORE,
            addEditOptions: DEFAULT_ADD_EDIT,
            entityEventOptions: DEFAULT_ENTITY_EVENT,
          }));
          setRecipients(imported);
        }
      } catch {
        // Invalid JSON — silently ignore
      }
    };
    input.click();
  };

  // Dirty tracking: snapshot the initial config to detect unsaved changes
  const [loadedSnapshot, setLoadedSnapshot] = useState<string | null>(() =>
    initialConfig ? JSON.stringify({ providerUoi: initialConfig.providerUoi, concurrency: initialConfig.concurrency, recipients: initialConfig.recipients }) : null
  );
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [savePromptName, setSavePromptName] = useState('');

  const currentSnapshot = JSON.stringify({ providerUoi, concurrency, recipients });
  const isDirty = loadedSnapshot !== null && currentSnapshot !== loadedSnapshot;

  const handleStart = () => {
    if (isDirty && onSave) {
      setShowSavePrompt(true);
      // Suggest "<Existing Name> - <local date/time>" so a Save As keeps
      // the user's chosen base name and disambiguates revisions; for
      // brand-new configs fall back to "Config - <local date/time>".
      const stamp = new Date().toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      const base = savedConfigName ?? 'Config';
      setSavePromptName(`${base} - ${stamp}`);
      return;
    }
    onStart({ providerUoi, concurrency, recipients });
  };

  const handleSaveAndStart = (existingId?: string, name?: string) => {
    if (onSave) {
      onSave({ providerUoi, concurrency, recipients }, existingId, name);
      setLoadedSnapshot(currentSnapshot); // Reset dirty state after save
    }
    setShowSavePrompt(false);
    clearDraft().catch(() => {});
    onStart({ providerUoi, concurrency, recipients });
  };

  const handleSkipAndStart = () => {
    setShowSavePrompt(false);
    clearDraft().catch(() => {});
    onStart({ providerUoi, concurrency, recipients });
  };

  const canStart = providerUoi.trim() !== '' &&
    recipients.length > 0 &&
    recipients.every(r => r.recipientUoi.trim() !== '');

  return (
    <div className={`${CARD} p-6 space-y-5`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {savedConfigName ? savedConfigName : 'Test Configuration'}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {savedConfigName ? 'Editing saved configuration' : 'Configure one or more recipients to test against.'}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>

      {/* Provider + concurrency */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Provider org picker */}
        <div className="relative">
          <label className={LABEL}>
            Provider
            {lockedProviderUoi && (
              <span className="ml-2 text-[10px] font-normal text-gray-400 dark:text-gray-500">Locked to your account</span>
            )}
          </label>
          {providerUoi ? (
            <div className={`${INPUT} flex items-center justify-between`}>
              <div className="min-w-0">
                <span className="text-sm font-medium">{providerName}</span>
                <span className="ml-2 text-xs text-gray-400 dark:text-gray-500 font-mono">{providerUoi}</span>
              </div>
              {!lockedProviderUoi && (
                <button
                  type="button"
                  onClick={() => { setProviderUoi(''); setProviderName(''); setProviderSystems([]); }}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer shrink-0 ml-2"
                >
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              )}
            </div>
          ) : (
            <>
              <input
                type="text"
                value={providerSearch}
                onChange={e => { setProviderSearch(e.target.value); setShowProviderDropdown(true); setHighlightedOrgIndex(-1); }}
                onFocus={() => setShowProviderDropdown(true)}
                onBlur={() => setTimeout(() => setShowProviderDropdown(false), 200)}
                onKeyDown={e => {
                  if (!showProviderDropdown) return;
                  const visibleOrgs = orgs.filter(o => {
                    if (!providerSearch.trim()) return true;
                    const q = providerSearch.toLowerCase();
                    return o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q);
                  }).slice(0, 50);
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setHighlightedOrgIndex(i => Math.min(i + 1, visibleOrgs.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setHighlightedOrgIndex(i => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter' && highlightedOrgIndex >= 0 && highlightedOrgIndex < visibleOrgs.length) {
                    e.preventDefault();
                    selectProvider(visibleOrgs[highlightedOrgIndex]);
                  } else if (e.key === 'Escape') {
                    setShowProviderDropdown(false);
                  }
                }}
                placeholder={orgsLoading ? 'Loading organizations...' : 'Search by name or UOI...'}
                className={INPUT}
              />
              {showProviderDropdown && (
                <div className="absolute z-20 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {/* Saved config matches */}
                  {matchConfigs(providerSearch).length > 0 && (
                    <>
                      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800/80">
                        Saved Configs
                      </div>
                      {matchConfigs(providerSearch).map(config => (
                        <button
                          key={config.id}
                          type="button"
                          className="w-full px-3 py-2 text-left hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer"
                          onMouseDown={e => {
                            e.preventDefault();
                            if (config.providerUoi) {
                              setProviderUoi(config.providerUoi);
                              setProviderName(config.providerName ?? config.providerUoi);
                            }
                            buildRecipientFromConfig(config, savedCredentials).then(built => {
                              setRecipients([built]);
                              setShowProviderDropdown(false);
                              setProviderSearch('');
                            });
                          }}
                        >
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{config.name || config.recipientName || config.recipientUoi}</div>
                          <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{savedCredentials.get(config.credentialsId ?? '')?.url ?? config.recipientUoi}</div>
                          {config.recipientName && <div className="text-[10px] text-gray-400 dark:text-gray-500">Recipient: {config.recipientName}</div>}
                        </button>
                      ))}
                    </>
                  )}
                  {/* Org directory results */}
                  <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800/80">
                    Organizations
                  </div>
                  <OrgDropdown
                    orgs={orgs}
                    search={providerSearch}
                    onSelect={selectProvider}
                    inline
                  />
                </div>
              )}
            </>
          )}
        </div>
        <div>
          <label className={LABEL}>Concurrency</label>
          <div className="flex items-center gap-3">
            <select value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} className={SELECT}>
              {Array.from({ length: MAX_LOCAL_CONCURRENCY }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>{n === 1 ? 'Sequential (1 job)' : `${n} concurrent jobs`}</option>
              ))}
            </select>
          </div>
          {concurrency > MEMORY_WARNING_THRESHOLD && (
            <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
              DD jobs can use ~4 GB of memory each for large markets. Monitor system resources when running 3+ concurrently.
            </p>
          )}
        </div>
      </div>

      {/* Recipient configs */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
            Recipients ({recipients.length})
          </p>
          <button
            type="button"
            onClick={addRecipient}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer font-medium"
          >
            + Add Recipient
          </button>
        </div>

        {recipients.map((r, i) => (
          <RecipientCard
            key={r.id}
            recipient={r}
            index={i}
            onChange={updated => updateRecipient(i, updated)}
            onRemove={() => removeRecipient(i)}
            onDuplicate={() => duplicateRecipient(i)}
            orgs={orgs}
            providerSystems={providerSystems}
            matchConfigs={matchConfigs}
            savedCredentials={savedCredentials}
          />
        ))}
      </div>

      {/* Save prompt (shown when starting with unsaved changes) */}
      {showSavePrompt && (
        <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg space-y-2">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
            You have unsaved changes. Save before starting?
          </p>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {savedConfigId && savedConfigName && (
              <button
                type="button"
                onClick={() => handleSaveAndStart(savedConfigId, savedConfigName)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 cursor-pointer"
              >
                Save "{savedConfigName}"
              </button>
            )}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={savePromptName}
                onChange={e => setSavePromptName(e.target.value)}
                placeholder="Config name..."
                className="px-2 py-1.5 text-xs rounded border border-amber-300 dark:border-amber-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-amber-500 outline-none w-48"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && savePromptName.trim()) handleSaveAndStart(undefined, savePromptName.trim());
                  if (e.key === 'Escape') handleSkipAndStart();
                }}
              />
              <button
                type="button"
                onClick={() => { if (savePromptName.trim()) handleSaveAndStart(undefined, savePromptName.trim()); }}
                disabled={!savePromptName.trim()}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 cursor-pointer"
              >
                {savedConfigId ? 'Save As' : 'Save'}
              </button>
            </div>
            <button
              type="button"
              onClick={handleSkipAndStart}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500 cursor-pointer"
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {/* Actions bar */}
      <div className="flex items-center justify-between pt-3 border-t border-gray-100 dark:border-gray-700/50">
        {/* Left side: Import · Export */}
        <div className="flex items-center gap-3">
          <button type="button" onClick={handleImport} className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer py-2">
            Import
          </button>
          <button type="button" onClick={handleExport} className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer py-2">
            Export
          </button>
        </div>

        {/* Right side: Summary + Cancel + Start */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {recipients.length} {recipients.length === 1 ? 'recipient' : 'recipients'} · {totalJobs} {totalJobs === 1 ? 'job' : 'jobs'}
          </span>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={!canStart}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              canStart
                ? 'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer'
                : 'bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500 cursor-not-allowed'
            }`}
          >
            Start {totalJobs > 1 ? `${totalJobs} Jobs` : 'Test'}
          </button>
        </div>
      </div>
    </div>
  );
};
