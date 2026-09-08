import { randomUUID } from 'node:crypto';
import { ExpandParseError, LexerError, ParseError, parseExpand } from '@reso-standards/odata-expression-parser';
import type { RequestHandler } from 'express';
import type { CollectionQueryOptions, DataAccessLayer, NavigationPropertyBinding, ResourceContext } from '../db/data-access.js';
import { buildAnnotations } from './annotations.js';
import { resolveBaseUrl } from './base-url.js';
import { buildODataError, buildValidationError } from './errors.js';
import { setODataHeaders, type ODataHeaderOptions } from './headers.js';
import { validateRequestBody } from './validation.js';

/** Returns true if the error is a client-facing filter validation error (e.g. unknown field). */
const isFilterError = (err: unknown): err is Error =>
  err instanceof Error && (err.message.includes('$filter') || err.message.includes('Unknown field'));

/** Extracts the OData key from a URL path like `/Property('12345')`. */
const extractKey = (path: string): string | undefined => {
  const match = path.match(/\('([^']+)'\)/);
  return match?.[1];
};

/** Default number of records per page when no $top or maxpagesize is specified. */
const DEFAULT_PAGE_SIZE = 100;

/** Absolute maximum records per single response, regardless of client request. */
const MAX_PAGE_SIZE = 2000;

/** Determines if the Prefer header requests minimal response. */
const prefersMinimal = (prefer: string | undefined): boolean => prefer?.includes('return=minimal') ?? false;

/** Parses `Prefer: odata.maxpagesize=N` from the Prefer header value. Returns undefined if not present or invalid. */
const parseMaxPageSize = (prefer: string | undefined): number | undefined => {
  if (!prefer) return undefined;
  const match = prefer.match(/odata\.maxpagesize\s*=\s*(\d+)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value > 0 ? value : undefined;
};

/** Options shared by all handler factories. */
export interface HandlerContext {
  readonly resourceCtx: ResourceContext;
  readonly dal: DataAccessLayer;
  /** Explicit base-URL override (BASE_URL) or undefined. Each handler resolves the effective base per request
   *  via `resolveBaseUrl(req, ctx.baseUrlOverride)` — so response links are correct without static config. */
  readonly baseUrlOverride?: string;
}

/** Creates a POST handler for creating new records. */
export const createHandler =
  (ctx: HandlerContext): RequestHandler =>
  async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;

      const failures = validateRequestBody(body, ctx.resourceCtx.fields);
      if (failures.length > 0) {
        setODataHeaders(res);
        res.status(400).json(buildValidationError(failures, 'Create'));
        return;
      }

      const key = randomUUID();
      const record = {
        ...body,
        [ctx.resourceCtx.keyField]: key,
        ModificationTimestamp: new Date().toISOString()
      };

      const row = await ctx.dal.insert(ctx.resourceCtx, record);

      const baseUrl = resolveBaseUrl(req, ctx.baseUrlOverride);
      const locationUrl = `${baseUrl}/${ctx.resourceCtx.resource}('${key}')`;

      if (prefersMinimal(req.headers.prefer as string | undefined)) {
        setODataHeaders(res, {
          entityId: key,
          locationUrl,
          preferenceApplied: 'return=minimal'
        });
        res.status(204).send();
        return;
      }

      setODataHeaders(res, {
        entityId: key,
        locationUrl,
        preferenceApplied: 'return=representation'
      });
      res.status(201).json({
        ...buildAnnotations(baseUrl, ctx.resourceCtx.resource, key),
        ...row
      });
    } catch (err) {
      setODataHeaders(res);
      res.status(500).json(buildODataError('50000', err instanceof Error ? err.message : 'Internal server error', [], 'Create'));
    }
  };

/** Creates a GET handler for retrieving a single record by key. */
export const readHandler =
  (ctx: HandlerContext): RequestHandler =>
  async (req, res) => {
    try {
      const key = extractKey(req.path);
      if (!key) {
        setODataHeaders(res);
        res
          .status(400)
          .json(buildValidationError([{ field: 'key', reason: "Missing resource key in URL. Use the format /Resource('key')." }], 'Read'));
        return;
      }

      const selectParam = req.query.$select as string | undefined;
      const expandParam = req.query.$expand as string | undefined;
      const expandTree = expandParam ? parseExpand(expandParam) : undefined;

      const row = await ctx.dal.readByKey(ctx.resourceCtx, key, {
        $select: selectParam,
        $expand: expandTree
      });

      if (!row) {
        setODataHeaders(res);
        res.status(404).json(buildODataError('40400', `No ${ctx.resourceCtx.resource} record found with key '${key}'.`, [], 'Read'));
        return;
      }

      setODataHeaders(res);
      res.status(200).json({
        ...buildAnnotations(resolveBaseUrl(req, ctx.baseUrlOverride), ctx.resourceCtx.resource, key),
        ...row
      });
    } catch (err) {
      setODataHeaders(res);
      res.status(500).json(buildODataError('50000', err instanceof Error ? err.message : 'Internal server error', [], 'Read'));
    }
  };

/**
 * Creates a GET handler for the OData navigation-property-path: `/{Resource}('key')/{NavProp}`.
 *
 * Per Web API Core 2.1.0 §2.5.10.2, after collecting a key from the parent, `GET /{Resource}('{key}')/{NavProp}`
 * returns the related entity(ies). This reuses the existing `$expand` child-resolution end-to-end — it reads the
 * parent by key with `$expand={NavProp}` and returns the resolved navigation property as a top-level response:
 * a collection (`{ @odata.context, value: [...] }`) for a collection-valued nav, or the single related entity
 * otherwise. Because the FK strategies (resource-record-key / direct / parent-fk) live in the DAL's expand path,
 * a polymorphic child (Media, …) comes back already carrying its ResourceName / ResourceRecordKey back-reference.
 */
export const navigationPropertyHandler =
  (ctx: HandlerContext, binding: NavigationPropertyBinding): RequestHandler =>
  async (req, res) => {
    try {
      const key = extractKey(req.path);
      if (!key) {
        setODataHeaders(res);
        res
          .status(400)
          .json(buildValidationError([{ field: 'key', reason: "Missing resource key in URL. Use the format /Resource('key')/NavProp." }], 'Read'));
        return;
      }

      // Resolve the parent + its navigation property via the same $expand machinery. A nested $select on the
      // nav path is passed through to the expansion (so /Property('k')/Media?$select=MediaKey works).
      const selectParam = req.query.$select as string | undefined;
      const parent = await ctx.dal.readByKey(ctx.resourceCtx, key, {
        $expand: [{ property: binding.name, options: selectParam ? { $select: selectParam } : {} }]
      });

      if (!parent) {
        setODataHeaders(res);
        res.status(404).json(buildODataError('40400', `No ${ctx.resourceCtx.resource} record found with key '${key}'.`, [], 'Read'));
        return;
      }

      const baseUrl = resolveBaseUrl(req, ctx.baseUrlOverride);
      const expanded = parent[binding.name];

      if (binding.isCollection) {
        // A collection nav always returns 200 with a (possibly empty) value array — a parent with no children.
        const value = Array.isArray(expanded) ? expanded : [];
        setODataHeaders(res);
        res.status(200).json({
          '@odata.context': `${baseUrl}/$metadata#${binding.targetResource}`,
          value
        });
        return;
      }

      // To-one navigation: the related single entity, or 404 when the relationship is unset.
      if (expanded == null || typeof expanded !== 'object') {
        setODataHeaders(res);
        res.status(404).json(buildODataError('40400', `No ${binding.name} related to ${ctx.resourceCtx.resource}('${key}').`, [], 'Read'));
        return;
      }
      setODataHeaders(res);
      res.status(200).json({
        '@odata.context': `${baseUrl}/$metadata#${binding.targetResource}/$entity`,
        ...(expanded as Record<string, unknown>)
      });
    } catch (err) {
      setODataHeaders(res);
      res.status(500).json(buildODataError('50000', err instanceof Error ? err.message : 'Internal server error', [], 'Read'));
    }
  };

/** Creates a PATCH handler for updating an existing record (merge semantics). */
export const updateHandler =
  (ctx: HandlerContext): RequestHandler =>
  async (req, res) => {
    try {
      const key = extractKey(req.path);
      if (!key) {
        setODataHeaders(res);
        res
          .status(400)
          .json(
            buildValidationError([{ field: 'key', reason: "Missing resource key in URL. Use the format /Resource('key')." }], 'Update')
          );
        return;
      }

      const body = req.body as Record<string, unknown>;

      // PATCH is a partial update — skip required-field validation
      const failures = validateRequestBody(body, ctx.resourceCtx.fields, true);
      if (failures.length > 0) {
        setODataHeaders(res);
        res.status(400).json(buildValidationError(failures, 'Update'));
        return;
      }

      const updates = {
        ...body,
        ModificationTimestamp: new Date().toISOString()
      };

      const row = await ctx.dal.update(ctx.resourceCtx, key, updates);
      const baseUrl = resolveBaseUrl(req, ctx.baseUrlOverride);
      const locationUrl = `${baseUrl}/${ctx.resourceCtx.resource}('${key}')`;

      if (!row) {
        // Record doesn't exist — insert it instead (upsert semantics)
        const record = { ...updates, [ctx.resourceCtx.keyField]: key };
        const newRow = await ctx.dal.insert(ctx.resourceCtx, record);

        if (prefersMinimal(req.headers.prefer as string | undefined)) {
          setODataHeaders(res, {
            entityId: key,
            locationUrl,
            preferenceApplied: 'return=minimal'
          });
          res.status(204).send();
          return;
        }

        setODataHeaders(res, {
          entityId: key,
          locationUrl,
          preferenceApplied: 'return=representation'
        });
        res.status(200).json({
          ...buildAnnotations(baseUrl, ctx.resourceCtx.resource, key),
          ...newRow
        });
        return;
      }

      if (prefersMinimal(req.headers.prefer as string | undefined)) {
        setODataHeaders(res, {
          entityId: key,
          locationUrl,
          preferenceApplied: 'return=minimal'
        });
        res.status(204).send();
        return;
      }

      setODataHeaders(res, {
        entityId: key,
        locationUrl,
        preferenceApplied: 'return=representation'
      });
      res.status(200).json({
        ...buildAnnotations(baseUrl, ctx.resourceCtx.resource, key),
        ...row
      });
    } catch (err) {
      setODataHeaders(res);
      res.status(500).json(buildODataError('50000', err instanceof Error ? err.message : 'Internal server error', [], 'Update'));
    }
  };

/** Creates a DELETE handler for removing a record by key. */
export const deleteHandler =
  (ctx: HandlerContext): RequestHandler =>
  async (req, res) => {
    try {
      const key = extractKey(req.path);
      if (!key) {
        setODataHeaders(res);
        res.status(400).json(buildODataError('20100', "Missing resource key in URL. Use the format /Resource('key').", [], 'Delete'));
        return;
      }

      const deleted = await ctx.dal.deleteByKey(ctx.resourceCtx, key);
      if (!deleted) {
        setODataHeaders(res);
        res.status(404).json(buildODataError('40400', `No ${ctx.resourceCtx.resource} record found with key '${key}'.`, [], 'Delete'));
        return;
      }

      setODataHeaders(res);
      res.status(204).send();
    } catch (err) {
      setODataHeaders(res);
      res.status(500).json(buildODataError('50000', err instanceof Error ? err.message : 'Internal server error', [], 'Delete'));
    }
  };

/** Raw query params used for nextLink serialization (avoids round-tripping parsed $expand). */
interface RawQueryParams {
  readonly $filter?: string;
  readonly $select?: string;
  readonly $orderby?: string;
  readonly $top?: number;
  readonly $skip?: number;
  readonly $count?: boolean;
  readonly $expand?: string;
}

/** Builds an @odata.nextLink URL for server-driven pagination.
 *  - `clientTop` is the original $top from the client (undefined = no $top).
 *  - `pageSize` is the effective page size used for this response.
 */
const buildNextLink = (
  baseUrl: string,
  resource: string,
  raw: RawQueryParams,
  pageSize: number,
  skip: number,
  clientTop: number | undefined
): string => {
  const nextSkip = skip + pageSize;
  const params: string[] = [];
  if (raw.$filter) params.push(`$filter=${encodeURIComponent(raw.$filter)}`);
  if (raw.$select) params.push(`$select=${encodeURIComponent(raw.$select)}`);
  if (raw.$orderby) params.push(`$orderby=${encodeURIComponent(raw.$orderby)}`);
  // Preserve the client's original $top so subsequent pages know the total obligation
  if (clientTop !== undefined) params.push(`$top=${clientTop}`);
  params.push(`$skip=${nextSkip}`);
  if (raw.$count) params.push('$count=true');
  if (raw.$expand) params.push(`$expand=${encodeURIComponent(raw.$expand)}`);
  return `${baseUrl}/${resource}?${params.join('&')}`;
};

/** Creates a GET handler for querying a collection of entities. */
export const collectionHandler =
  (ctx: HandlerContext): RequestHandler =>
  async (req, res) => {
    try {
      const rawExpand = req.query.$expand as string | undefined;
      const expandTree = rawExpand ? parseExpand(rawExpand) : undefined;

      const prefer = req.headers.prefer as string | undefined;
      const maxPageSize = parseMaxPageSize(prefer);
      const clientTop = req.query.$top ? Number(req.query.$top) : undefined;
      const skip = req.query.$skip ? Number(req.query.$skip) : 0;

      // Effective page size: prefer maxpagesize header, then $top, fall back to default, cap at max.
      // When $top is specified, the server tries to satisfy it in as few pages as possible.
      const effectivePageSize = Math.min(maxPageSize ?? clientTop ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

      // How many records to fetch: the lesser of $top (per-page client limit) and
      // effective page size. $skip is an independent offset per OData spec.
      const fetchLimit = clientTop !== undefined
        ? Math.min(clientTop, effectivePageSize)
        : effectivePageSize;

      const options: CollectionQueryOptions = {
        ...(req.query.$filter && { $filter: req.query.$filter as string }),
        ...(req.query.$select && { $select: req.query.$select as string }),
        ...(req.query.$orderby && { $orderby: req.query.$orderby as string }),
        $top: fetchLimit,
        ...(skip > 0 && { $skip: skip }),
        ...(req.query.$count === 'true' && { $count: true }),
        ...(expandTree && { $expand: expandTree })
      };

      const result = await ctx.dal.queryCollection(ctx.resourceCtx, options);

      const baseUrl = resolveBaseUrl(req, ctx.baseUrlOverride);
      const body: Record<string, unknown> = {
        '@odata.context': `${baseUrl}/$metadata#${ctx.resourceCtx.resource}`,
        value: result.value
      };
      if (result.count !== undefined) {
        body['@odata.count'] = result.count;
      }

      // Server-driven pagination: include @odata.nextLink only when the result is partial.
      // The result is partial when we got back exactly fetchLimit records AND the client
      // is still owed more (or has no $top limit, meaning we page indefinitely).
      const returned = result.value.length;
      const isFullPage = returned === fetchLimit && fetchLimit > 0;
      const clientSatisfied = clientTop !== undefined && (skip + returned) >= clientTop;
      if (isFullPage && !clientSatisfied) {
        const rawParams: RawQueryParams = {
          $filter: options.$filter,
          $select: options.$select,
          $orderby: options.$orderby,
          $top: clientTop,
          $skip: skip,
          $count: options.$count,
          $expand: rawExpand
        };
        body['@odata.nextLink'] = buildNextLink(
          baseUrl, ctx.resourceCtx.resource, rawParams, fetchLimit, skip, clientTop
        );
      }

      const headerOpts: ODataHeaderOptions = maxPageSize !== undefined
        ? { preferenceApplied: `odata.maxpagesize=${Math.min(maxPageSize, MAX_PAGE_SIZE)}` }
        : {};
      setODataHeaders(res, headerOpts);
      res.status(200).json(body);
    } catch (err) {
      setODataHeaders(res);
      if (err instanceof ParseError || err instanceof LexerError || err instanceof ExpandParseError || isFilterError(err)) {
        const msg = err instanceof Error ? err.message : 'Invalid query expression';
        const target = err instanceof ExpandParseError ? '$expand' : '$filter';
        res.status(400).json(buildODataError('40000', msg, [{ target, message: msg }], 'Query'));
        return;
      }
      res.status(500).json(buildODataError('50000', err instanceof Error ? err.message : 'Internal server error', [], 'Query'));
    }
  };
