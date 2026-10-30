import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildResourceUrl,
  buildScenarioResult,
  extractPrimaryKey,
  fetchMetadata,
  getEntityType,
  loadMetadataFromFile,
  makeSchemaAssertion,
  odataRequest,
  parseMetadataXml,
  resolveAuthToken,
  stripPrimaryKey,
  validateEntityIdHeader,
  validateJsonResponse,
  validateLocationHeader,
  validateODataAnnotation,
  validateODataError,
  validateODataVersionHeader,
  validatePreferenceApplied,
  validateResponseContainsPayload,
  validateStatusCode,
  validateStatusCodeRange
} from '../test-runner/index.js';
import type { EntityType, ODataResponse, ScenarioResult, TestAssertion, TestConfig, TestReport } from '../test-runner/types.js';
import { type AddEditPayloadName, type AddEditTestPlan, PAYLOAD_FILES, payloadsFor, planAddEditTests } from './plan.js';
import type { DeletePayload, ScenarioName } from './types.js';

/**
 * Rewrites a server-returned URL to use the configured service root.
 * Handles cases where the server returns internal hostnames (e.g., Docker service names).
 */
const rebaseUrl = (returnedUrl: string, configuredServerUrl: string): string => {
  try {
    const returned = new URL(returnedUrl);
    const configured = new URL(configuredServerUrl);
    returned.protocol = configured.protocol;
    returned.host = configured.host;
    return returned.toString();
  } catch {
    return returnedUrl;
  }
};

/** The tags each scenario reports. One table, so a scenario refused before it sends anything reports the same ones. */
const SCENARIO_TAGS: Readonly<Record<ScenarioName, ReadonlyArray<string>>> = {
  'create-succeeds-representation': [
    '@create',
    '@create-succeeds',
    '@add-edit-endorsement',
    '@rcp-010',
    '@2.1.0',
    '@return-representation'
  ],
  'create-succeeds-minimal': ['@create', '@create-succeeds', '@add-edit-endorsement', '@rcp-010', '@2.1.0', '@return-minimal'],
  'create-fails': ['@create', '@create-fails', '@add-edit-endorsement', '@rcp-010', '@1.0.2'],
  'update-succeeds-representation': [
    '@update',
    '@update-succeeds',
    '@add-edit-endorsement',
    '@rcp-010',
    '@2.0.0',
    '@return-representation'
  ],
  'update-succeeds-minimal': ['@update', '@update-succeeds', '@add-edit-endorsement', '@rcp-010', '@2.0.0', '@return-minimal'],
  'update-fails': ['@update', '@update-fails', '@add-edit-endorsement', '@rcp-010', '@1.0.2'],
  'delete-succeeds': ['@delete', '@delete-succeeds', '@add-edit-endorsement', '@rcp-010', '@2.0.0'],
  'delete-fails': ['@delete', '@delete-fails', '@add-edit-endorsement', '@rcp-010', '@2.0.0']
};

// ── Public API ──

/** The payloads a run loaded: the ones its plan needs, by name. */
type LoadedPayloads = Readonly<Partial<Record<AddEditPayloadName, Record<string, unknown>>>>;

/**
 * Runs the Add/Edit scenarios a run was given, against a server, one after another.
 *
 * 1. Loads metadata (from server or local file)
 * 2. Validates the target resource exists in metadata
 * 3. Reads the actions and formats into the scenarios to run (`planAddEditTests`): all eight when none are given
 * 4. Loads the payload files those scenarios need, and no others
 * 5. Runs each scenario in order: create, update, delete. An update or a delete whose payload names no record uses
 *    the record a create test just made. One with no record to use fails without sending anything, because a write
 *    with no key would go to the whole collection's URL.
 * 6. Returns a structured TestReport with per-scenario results and a summary
 */
export const runAllScenarios = async (config: TestConfig): Promise<TestReport> => {
  const authToken = await resolveAuthToken(config.auth);

  const metadataXml = config.metadataPath
    ? await loadMetadataFromFile(config.metadataPath)
    : await fetchMetadata(config.serverUrl, authToken);

  const metadata = parseMetadataXml(metadataXml);
  const entityType = getEntityType(metadata, config.resource);

  if (!entityType) {
    throw new Error(
      `Entity type "${config.resource}" not found in metadata. Available: ${metadata.entityTypes.map(et => et.name).join(', ')}`
    );
  }

  const planned = planAddEditTests({ actions: config.actions, formats: config.formats });
  if ('problems' in planned) throw new Error(planned.problems.join(' '));

  const payloads = await readPayloads(config.payloadsDir, payloadsFor(planned.plan));
  const scenarios = await runPlan(planned.plan, config, authToken, payloads, entityType);

  const passed = scenarios.filter(s => s.passed).length;
  const failed = scenarios.filter(s => !s.passed).length;

  return {
    serverUrl: config.serverUrl,
    resource: config.resource,
    timestamp: new Date().toISOString(),
    scenarios,
    summary: {
      total: scenarios.length,
      passed,
      failed,
      skipped: 0
    }
  };
};

// ── Payload Loading ──

/**
 * Loads the payload files a plan needs from a directory, and no others: a run that tests only create needs only
 * create-succeeds.json and create-fails.json. A file it needs and cannot find is named.
 */
export const readPayloads = async (payloadsDir: string, names: ReadonlyArray<AddEditPayloadName>): Promise<LoadedPayloads> => {
  const read = await Promise.all(
    names.map(async name => {
      const content = await readFile(join(payloadsDir, PAYLOAD_FILES[name]), 'utf-8').catch(() => undefined);
      return [name, content] as const;
    })
  );
  // Every missing file, in the order the tests use them, so the message is the same on every run.
  const missing = read.filter(([, content]) => content === undefined).map(([name]) => PAYLOAD_FILES[name]);
  if (missing.length > 0) throw new Error(`The payloads folder has no ${missing.join(', ')}, which this run's tests need`);
  return Object.fromEntries(read.map(([name, content]) => [name, JSON.parse(content ?? '{}') as Record<string, unknown>]));
};

/** A payload the plan needs. Loading it is checked above, so its absence here is a bug, not a configuration. */
const payloadOf = (payloads: LoadedPayloads, name: AddEditPayloadName): Record<string, unknown> => {
  const payload = payloads[name];
  if (payload === undefined) throw new Error(`No ${name} payload was loaded for a test that needs it`);
  return payload;
};

// ── Running a Plan ──

/** The key in an entity's URL: `Resource('key')`, with doubled quotes inside, or `Resource(123)`. */
const ENTITY_URL_KEY = /\((?:'((?:[^']|'')*)'|([^)']*))\)\s*$/;

/**
 * The key a header names: from an entity URL (`OData-EntityId`, `Location`), or the key itself, which is what
 * RESO's `EntityId` carries (RCP-010's examples read `EntityId: "12345"`), quoted or not.
 */
const keyFromHeader = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const match = text.match(ENTITY_URL_KEY);
  if (match) {
    const key = match[1]?.replaceAll("''", "'") ?? match[2];
    return key ? decodeURIComponent(key) : undefined;
  }
  const bare = text.replace(/^"(.*)"$/, '$1');
  return bare !== '' && !bare.includes('/') ? bare : undefined;
};

/**
 * The key a create gave the record it made: from the record it returned, else from the headers that name it,
 * `EntityId` first. Undefined when the create did not succeed. Exported so each response shape can be tested.
 */
export const createdKeyOf = (response: ODataResponse, entityType: EntityType): string | undefined => {
  if (response.status !== 201 && response.status !== 204) return undefined;
  const keyProp = entityType.keyProperties[0];
  const body = response.body;
  const fromBody = keyProp && body && typeof body === 'object' ? (body as Record<string, unknown>)[keyProp] : undefined;
  if (fromBody !== undefined && fromBody !== null && String(fromBody) !== '') return String(fromBody);
  return (
    keyFromHeader(response.headers.entityid) ??
    keyFromHeader(response.headers['odata-entityid']) ??
    keyFromHeader(response.headers.location)
  );
};

/** A non-empty key, or undefined. A falsy key makes `buildResourceUrl` answer with the collection's URL. */
const keyOf = (value: unknown): string | undefined =>
  value === undefined || value === null || String(value) === '' ? undefined : String(value);

/** A scenario that cannot name its record fails without sending anything. */
const refused = (name: ScenarioName, start: number, description: string, actual: string): ScenarioResult =>
  buildScenarioResult(name, SCENARIO_TAGS[name], [{ description, status: 'fail', expected: 'a record to act on', actual }], start);

interface ScenarioRun {
  readonly result: ScenarioResult;
  /** The key of the record a create made, for the updates and deletes after it. */
  readonly createdKey?: string;
}

/** Run one scenario, with the keys of the records the create tests before it made. */
const runScenario = async (
  name: ScenarioName,
  config: TestConfig,
  authToken: string,
  payloads: LoadedPayloads,
  entityType: EntityType,
  created: ReadonlyArray<string>
): Promise<ScenarioRun> => {
  const start = Date.now();
  const keyProp = entityType.keyProperties[0];

  // An update names its record by the resource's key, or takes the first record a create made.
  const updateWith = async (
    payload: Record<string, unknown>,
    run: (payload: Record<string, unknown>) => Promise<ScenarioResult>
  ): Promise<ScenarioRun> => {
    const key = keyProp ? (keyOf(payload[keyProp]) ?? created[0]) : undefined;
    if (key === undefined || keyProp === undefined) {
      return {
        result: refused(
          name,
          start,
          'Update names its record',
          `The payload names no ${keyProp ?? 'key'}, and no create test made a record to update`
        )
      };
    }
    return { result: await run({ ...payload, [keyProp]: key }) };
  };

  switch (name) {
    case 'create-succeeds-representation':
    case 'create-succeeds-minimal': {
      const run = name === 'create-succeeds-representation' ? runCreateSucceedsRepresentation : runCreateSucceedsMinimal;
      const { result, response } = await run(config, authToken, payloadOf(payloads, 'createSucceeds'), entityType);
      return { result, createdKey: createdKeyOf(response, entityType) };
    }
    case 'create-fails':
      return { result: await runCreateFails(config, authToken, payloadOf(payloads, 'createFails'), entityType) };
    case 'update-succeeds-representation':
      return updateWith(payloadOf(payloads, 'updateSucceeds'), payload =>
        runUpdateSucceedsRepresentation(config, authToken, payload, entityType)
      );
    case 'update-succeeds-minimal':
      return updateWith(payloadOf(payloads, 'updateSucceeds'), payload => runUpdateSucceedsMinimal(config, authToken, payload, entityType));
    case 'update-fails':
      return updateWith(payloadOf(payloads, 'updateFails'), payload => runUpdateFails(config, authToken, payload, entityType));
    case 'delete-succeeds': {
      // A delete names its record by url or id, or takes the last record a create made.
      const payload = payloadOf(payloads, 'deleteSucceeds') as DeletePayload;
      const id = keyOf(payload.id) ?? created.at(-1);
      if (!keyOf(payload.url) && id === undefined) {
        return {
          result: refused(
            name,
            start,
            'Delete names its record',
            'The payload names no id or url, and no create test made a record to delete'
          )
        };
      }
      return { result: await runDeleteSucceeds(config, authToken, keyOf(payload.url) ? payload : { id }, entityType) };
    }
    case 'delete-fails': {
      // A delete that should fail names a record that does not exist. It never takes a created one.
      const payload = payloadOf(payloads, 'deleteFails') as DeletePayload;
      if (!keyOf(payload.url) && !keyOf(payload.id)) {
        return {
          result: refused(name, start, 'Delete names its record', 'The payload names no id or url for a record that does not exist')
        };
      }
      return { result: await runDeleteFails(config, authToken, payload) };
    }
  }
};

/** Run a plan's scenarios in order, handing each the keys of the records the creates before it made. */
const runPlan = async (
  plan: AddEditTestPlan,
  config: TestConfig,
  authToken: string,
  payloads: LoadedPayloads,
  entityType: EntityType
): Promise<ReadonlyArray<ScenarioResult>> => {
  const created: string[] = [];
  const results: ScenarioResult[] = [];
  for (const name of plan.scenarios) {
    const { result, createdKey } = await runScenario(name, config, authToken, payloads, entityType, created);
    if (createdKey !== undefined) created.push(createdKey);
    results.push(result);
  }
  return results;
};

// ── Create Scenarios ──

/** POST with Prefer: return=representation. Validates 201 response, OData annotations, and follow-up GET. */
const runCreateSucceedsRepresentation = async (
  config: TestConfig,
  authToken: string,
  payload: Record<string, unknown>,
  entityType: EntityType
): Promise<{ readonly result: ScenarioResult; readonly response: ODataResponse }> => {
  const start = Date.now();
  const assertions: TestAssertion[] = [];

  assertions.push(makeSchemaAssertion(payload, entityType));

  const url = buildResourceUrl(config.serverUrl, config.resource);
  const response = await odataRequest({
    method: 'POST',
    url,
    body: payload,
    authToken,
    headers: { Prefer: 'return=representation' }
  });

  assertions.push(validateStatusCode(response, [201, 204]));
  assertions.push(validateODataVersionHeader(response));
  assertions.push(validateEntityIdHeader(response));
  assertions.push(...validateLocationHeader(response, config.resource));
  assertions.push(validatePreferenceApplied(response, 'return=representation'));

  if (response.status !== 204) {
    assertions.push(validateJsonResponse(response));
    assertions.push(...validateODataAnnotation(response, '@odata.context', 'MAY'));
    assertions.push(...validateODataAnnotation(response, '@odata.id', 'MAY'));
    assertions.push(...validateODataAnnotation(response, '@odata.editLink', 'MUST'));
    assertions.push(...validateResponseContainsPayload(response.body, payload));
  }

  // Follow-up GET
  const locationUrl = response.headers.location;
  if (locationUrl) {
    const getResponse = await odataRequest({
      method: 'GET',
      url: rebaseUrl(locationUrl, config.serverUrl),
      authToken
    });
    assertions.push(validateStatusCode(getResponse, [200]));
    assertions.push(validateODataVersionHeader(getResponse));
    assertions.push(...validateResponseContainsPayload(getResponse.body, payload));
  }

  return {
    result: buildScenarioResult('create-succeeds-representation', SCENARIO_TAGS['create-succeeds-representation'], assertions, start),
    response
  };
};

/** POST with Prefer: return=minimal. Validates 204 response with headers only, and follow-up GET. */
const runCreateSucceedsMinimal = async (
  config: TestConfig,
  authToken: string,
  payload: Record<string, unknown>,
  entityType: EntityType
): Promise<{ readonly result: ScenarioResult; readonly response: ODataResponse }> => {
  const start = Date.now();
  const assertions: TestAssertion[] = [];

  assertions.push(makeSchemaAssertion(payload, entityType));

  const url = buildResourceUrl(config.serverUrl, config.resource);
  const response = await odataRequest({
    method: 'POST',
    url,
    body: payload,
    authToken,
    headers: { Prefer: 'return=minimal' }
  });

  assertions.push(validateStatusCode(response, [201, 204]));
  assertions.push(validateODataVersionHeader(response));
  assertions.push(validateEntityIdHeader(response));
  assertions.push(...validateLocationHeader(response, config.resource));
  assertions.push(validatePreferenceApplied(response, 'return=minimal'));

  // Follow-up GET
  const locationUrl = response.headers.location;
  if (locationUrl) {
    const getResponse = await odataRequest({
      method: 'GET',
      url: rebaseUrl(locationUrl, config.serverUrl),
      authToken
    });
    assertions.push(validateStatusCode(getResponse, [200]));
    assertions.push(validateODataVersionHeader(getResponse));
    assertions.push(...validateResponseContainsPayload(getResponse.body, payload));
  }

  return {
    result: buildScenarioResult('create-succeeds-minimal', SCENARIO_TAGS['create-succeeds-minimal'], assertions, start),
    response
  };
};

/** POST with known-bad payload. Validates 400 response and OData error format with field-level details. */
const runCreateFails = async (
  config: TestConfig,
  authToken: string,
  payload: Record<string, unknown>,
  entityType: EntityType
): Promise<ScenarioResult> => {
  const start = Date.now();
  const assertions: TestAssertion[] = [];

  assertions.push(makeSchemaAssertion(payload, entityType));

  const url = buildResourceUrl(config.serverUrl, config.resource);
  const response = await odataRequest({
    method: 'POST',
    url,
    body: payload,
    authToken,
    headers: { Prefer: 'return=representation' }
  });

  assertions.push(validateStatusCode(response, [400]));
  assertions.push(validateODataVersionHeader(response));
  assertions.push(...validateODataError(response, entityType));

  return buildScenarioResult('create-fails', SCENARIO_TAGS['create-fails'], assertions, start);
};

// ── Update Scenarios ──

/** PATCH with Prefer: return=representation. Validates 200 response, @odata.etag, and follow-up GET. */
const runUpdateSucceedsRepresentation = async (
  config: TestConfig,
  authToken: string,
  payload: Record<string, unknown>,
  entityType: EntityType
): Promise<ScenarioResult> => {
  const start = Date.now();
  const assertions: TestAssertion[] = [];
  const targetKey = extractPrimaryKey(payload, entityType);
  const sendPayload = stripPrimaryKey(payload, entityType);

  assertions.push(makeSchemaAssertion(payload, entityType));

  const url = buildResourceUrl(config.serverUrl, config.resource, targetKey);
  const response = await odataRequest({
    method: 'PATCH',
    url,
    body: sendPayload,
    authToken,
    headers: { Prefer: 'return=representation' }
  });

  assertions.push(validateStatusCode(response, [200, 204]));
  assertions.push(validateODataVersionHeader(response));
  assertions.push(validateEntityIdHeader(response));
  assertions.push(...validateLocationHeader(response, config.resource));
  assertions.push(validatePreferenceApplied(response, 'return=representation'));

  if (response.status !== 204) {
    assertions.push(validateJsonResponse(response));
    assertions.push(...validateODataAnnotation(response, '@odata.etag', 'MUST'));
    assertions.push(...validateODataAnnotation(response, '@odata.context', 'MAY'));
    assertions.push(...validateODataAnnotation(response, '@odata.id', 'MAY'));
    assertions.push(...validateODataAnnotation(response, '@odata.editLink', 'MUST'));
    assertions.push(...validateResponseContainsPayload(response.body, sendPayload));
  }

  // Follow-up GET
  const locationUrl = response.headers.location;
  if (locationUrl) {
    const getResponse = await odataRequest({
      method: 'GET',
      url: rebaseUrl(locationUrl, config.serverUrl),
      authToken
    });
    assertions.push(validateStatusCode(getResponse, [200]));
    assertions.push(validateODataVersionHeader(getResponse));
    assertions.push(...validateResponseContainsPayload(getResponse.body, sendPayload));
  }

  return buildScenarioResult('update-succeeds-representation', SCENARIO_TAGS['update-succeeds-representation'], assertions, start);
};

/** PATCH with Prefer: return=minimal. Validates 204 response with headers only, and follow-up GET. */
const runUpdateSucceedsMinimal = async (
  config: TestConfig,
  authToken: string,
  payload: Record<string, unknown>,
  entityType: EntityType
): Promise<ScenarioResult> => {
  const start = Date.now();
  const assertions: TestAssertion[] = [];
  const targetKey = extractPrimaryKey(payload, entityType);
  const sendPayload = stripPrimaryKey(payload, entityType);

  assertions.push(makeSchemaAssertion(payload, entityType));

  const url = buildResourceUrl(config.serverUrl, config.resource, targetKey);
  const response = await odataRequest({
    method: 'PATCH',
    url,
    body: sendPayload,
    authToken,
    headers: { Prefer: 'return=minimal' }
  });

  assertions.push(validateStatusCode(response, [200, 204]));
  assertions.push(validateODataVersionHeader(response));
  assertions.push(validateEntityIdHeader(response));
  assertions.push(...validateLocationHeader(response, config.resource));

  // Follow-up GET
  const locationUrl = response.headers.location;
  if (locationUrl) {
    const getResponse = await odataRequest({
      method: 'GET',
      url: rebaseUrl(locationUrl, config.serverUrl),
      authToken
    });
    assertions.push(validateStatusCode(getResponse, [200]));
    assertions.push(validateODataVersionHeader(getResponse));
    assertions.push(...validateResponseContainsPayload(getResponse.body, sendPayload));
  }

  return buildScenarioResult('update-succeeds-minimal', SCENARIO_TAGS['update-succeeds-minimal'], assertions, start);
};

/** PATCH with known-bad payload. Validates 400 response and OData error format with field-level details. */
const runUpdateFails = async (
  config: TestConfig,
  authToken: string,
  payload: Record<string, unknown>,
  entityType: EntityType
): Promise<ScenarioResult> => {
  const start = Date.now();
  const assertions: TestAssertion[] = [];
  const targetKey = extractPrimaryKey(payload, entityType);
  const sendPayload = stripPrimaryKey(payload, entityType);

  assertions.push(makeSchemaAssertion(payload, entityType));

  const url = buildResourceUrl(config.serverUrl, config.resource, targetKey);
  const response = await odataRequest({
    method: 'PATCH',
    url,
    body: sendPayload,
    authToken,
    headers: { Prefer: 'return=representation' }
  });

  assertions.push(validateStatusCode(response, [400]));
  assertions.push(validateODataVersionHeader(response));
  assertions.push(...validateODataError(response, entityType));

  return buildScenarioResult('update-fails', SCENARIO_TAGS['update-fails'], assertions, start);
};

// ── Delete Scenarios ──

/**
 * DELETE to a known-good resource URL. Validates 204 response, then performs
 * a follow-up GET to confirm the resource returns 404 (actually deleted).
 * The delete URL is built from either the payload's `url` field or its `id` + the resource name.
 */
const runDeleteSucceeds = async (
  config: TestConfig,
  authToken: string,
  deletePayload: DeletePayload,
  _entityType: EntityType
): Promise<ScenarioResult> => {
  const start = Date.now();
  const assertions: TestAssertion[] = [];

  const deleteUrl = deletePayload.url
    ? `${config.serverUrl}/${deletePayload.url}`
    : buildResourceUrl(config.serverUrl, config.resource, deletePayload.id);

  const response = await odataRequest({
    method: 'DELETE',
    url: deleteUrl,
    authToken
  });

  assertions.push(validateStatusCode(response, [204]));
  assertions.push(validateODataVersionHeader(response));

  // Follow-up GET should return 404
  const getResponse = await odataRequest({
    method: 'GET',
    url: deleteUrl,
    authToken
  });
  assertions.push(validateStatusCode(getResponse, [404]));
  assertions.push(validateODataVersionHeader(getResponse));

  return buildScenarioResult('delete-succeeds', SCENARIO_TAGS['delete-succeeds'], assertions, start);
};

/**
 * DELETE to a non-existent resource URL. Validates that the server returns
 * a 4xx status code (400-499) and the OData-Version header.
 */
const runDeleteFails = async (config: TestConfig, authToken: string, deletePayload: DeletePayload): Promise<ScenarioResult> => {
  const start = Date.now();
  const assertions: TestAssertion[] = [];

  const deleteUrl = deletePayload.url
    ? `${config.serverUrl}/${deletePayload.url}`
    : buildResourceUrl(config.serverUrl, config.resource, deletePayload.id);

  const response = await odataRequest({
    method: 'DELETE',
    url: deleteUrl,
    authToken
  });

  assertions.push(validateStatusCodeRange(response, 400, 499));
  assertions.push(validateODataVersionHeader(response));

  return buildScenarioResult('delete-fails', SCENARIO_TAGS['delete-fails'], assertions, start);
};
