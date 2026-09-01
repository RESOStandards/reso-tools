import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';

// ── Authentication ──

/** Authentication configuration: either a pre-fetched bearer token or OAuth2 Client Credentials. */
export type AuthConfig =
  | { readonly mode: 'token'; readonly authToken: string }
  | {
      readonly mode: 'client_credentials';
      readonly clientId: string;
      readonly clientSecret: string;
      readonly tokenUrl: string;
      readonly scope?: string;
    };

// ── Configuration ──

export interface TestConfig {
  /** Server base URL, e.g. "https://api.reso.org" */
  readonly serverUrl: string;
  /** OData resource name, e.g. "Property" */
  readonly resource: string;
  /** Path to directory containing payload JSON files */
  readonly payloadsDir: string;
  /** Authentication configuration (bearer token or OAuth2 Client Credentials) */
  readonly auth: AuthConfig;
  /** Optional path to local XML metadata file (skips $metadata fetch) */
  readonly metadataPath?: string;
  /** If true, start mock server instead of hitting real server */
  readonly useMock?: boolean;
}

// ── Metadata ──

export interface EntityProperty {
  readonly name: string;
  /** e.g. "Edm.String", "Edm.Decimal", "Collection(Edm.String)" */
  readonly type: string;
  readonly nullable?: boolean;
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly annotations?: Readonly<Record<string, string>>;
}

export interface EntityType {
  readonly name: string;
  readonly keyProperties: ReadonlyArray<string>;
  readonly properties: ReadonlyArray<EntityProperty>;
  /** Navigation properties ($expand targets) preserved from the CSDL entity type. Optional: present only when
   *  the source entity type declared at least one (omitted otherwise). `targetType` is the unqualified target
   *  entity type name. Consumed by the Web API Core sampler to select an expansion for the 2.1.0 $expand
   *  scenario; a missing field simply means the scenario has nothing to expand and skips. */
  readonly navigationProperties?: ReadonlyArray<{ readonly name: string; readonly isCollection: boolean; readonly targetType: string }>;
}

/** A top-level EntitySet declared in the EDMX EntityContainer, resolved to its underlying EntityType. */
export interface ParsedEntitySet {
  /** The EntitySet name (the segment a client GETs at the service root, e.g. `Property`). */
  readonly name: string;
  /** The unqualified EntityType name the set exposes (namespace stripped, e.g. `Property`). */
  readonly entityType: string;
}

export interface ParsedMetadata {
  readonly namespace: string;
  readonly entityTypes: ReadonlyArray<EntityType>;
  /** CSDL enum types (with IsFlags + members), preserved so the enum abstraction can classify a field
   *  by its real representation rather than a name-shape heuristic. */
  readonly enumTypes: ReadonlyArray<CsdlEnumType>;
  /** Top-level EntitySet declarations from the EDMX `<EntityContainer>` (name → underlying EntityType).
   *  Preserved so the serving detection can tell a resource that is DECLARED as a top-level set from one
   *  that only has an EntityType (declared shape) but no set. `undefined` when the document has no
   *  `<EntityContainer>`; an empty array when a container is present but declares no sets. Both are treated
   *  as INDETERMINATE by the detection (it can't prove absence from a surface that says nothing). */
  readonly entitySets?: ReadonlyArray<ParsedEntitySet>;
}

// ── Test Results ──

export type TestStatus = 'pass' | 'fail' | 'skip' | 'warn';

export interface TestAssertion {
  readonly description: string;
  readonly status: TestStatus;
  readonly expected?: string;
  readonly actual?: string;
  /** Gherkin step text this maps to */
  readonly gherkinStep?: string;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly tags: ReadonlyArray<string>;
  readonly assertions: ReadonlyArray<TestAssertion>;
  readonly passed: boolean;
  /** Duration in milliseconds */
  readonly duration: number;
}

export interface TestReport {
  readonly serverUrl: string;
  readonly resource: string;
  readonly timestamp: string;
  readonly scenarios: ReadonlyArray<ScenarioResult>;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
  };
}

// ── HTTP Layer ──

export interface ODataResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly rawBody: string;
}

// ── Mock Server ──

export interface MockServerOptions {
  readonly port?: number;
  readonly metadataXml: string;
  readonly resource: string;
}
