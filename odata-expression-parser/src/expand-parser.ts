/**
 * OData $expand expression parser.
 *
 * Parses $expand strings like:
 *   "Media"
 *   "Media($select=MediaURL;$orderby=Order)"
 *   "Media($select=MediaURL;$expand=Tags($top=5)),Rooms"
 *   "Rooms($levels=2)"
 *   "Rooms($levels=max)"
 *
 * Produces a typed `ExpandExpression[]` AST with recursive nesting for
 * multi-level expansions.
 *
 * @see OData 4.01 §5.1.3 — System Query Option $expand
 */

import type { ExpandExpression, ExpandQueryOptions } from './expand-types.js';

/** Error thrown when $expand parsing fails. */
export const ExpandParseError = class ExpandParseError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = 'ExpandParseError';
    this.position = position;
  }
};

/**
 * Split a string on a delimiter at depth 0 only (outside parentheses).
 * Returns trimmed, non-empty segments.
 */
const splitAtDepthZero = (input: string, delimiter: string): ReadonlyArray<string> => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '(') depth++;
    else if (input[i] === ')') depth--;
    else if (input[i] === delimiter && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter(p => p.length > 0);
};

/**
 * Parse the parenthesized query options section of a single expand clause.
 *
 * Input is the content BETWEEN the outer parens, e.g.:
 *   "$select=MediaURL;$orderby=Order;$expand=Tags($top=5)"
 *
 * Options are separated by ';' at depth 0.
 */
const parseExpandOptions = (optionsStr: string, basePosition: number): ExpandQueryOptions => {
  const segments = splitAtDepthZero(optionsStr, ';');
  const options: {
    $select?: string;
    $filter?: string;
    $orderby?: string;
    $top?: number;
    $skip?: number;
    $count?: boolean;
    $expand?: ReadonlyArray<ExpandExpression>;
    $levels?: number | 'max';
  } = {};

  for (const segment of segments) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx < 0) {
      throw new ExpandParseError(`Expected '=' in expand option: "${segment}"`, basePosition);
    }

    const key = segment.slice(0, eqIdx).trim();
    const value = segment.slice(eqIdx + 1).trim();

    switch (key) {
      case '$select':
        options.$select = value;
        break;
      case '$filter':
        options.$filter = value;
        break;
      case '$orderby':
        options.$orderby = value;
        break;
      case '$top': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          throw new ExpandParseError(`Invalid $top value: "${value}"`, basePosition);
        }
        options.$top = n;
        break;
      }
      case '$skip': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          throw new ExpandParseError(`Invalid $skip value: "${value}"`, basePosition);
        }
        options.$skip = n;
        break;
      }
      case '$count':
        options.$count = value === 'true';
        break;
      case '$expand':
        options.$expand = parseExpandClauses(value, basePosition);
        break;
      case '$levels':
        options.$levels = value === 'max' ? 'max' : (() => {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) {
            throw new ExpandParseError(`Invalid $levels value: "${value}"`, basePosition);
          }
          return n;
        })();
        break;
      default:
        throw new ExpandParseError(`Unknown expand option: "${key}"`, basePosition);
    }
  }

  return options;
};

/**
 * Parse a single expand clause — a navigation property name optionally
 * followed by parenthesized query options.
 *
 * Examples:
 *   "Media"
 *   "Media($select=MediaURL)"
 *   "Rooms($levels=2)"
 */
const parseExpandClause = (clause: string, basePosition: number): ExpandExpression => {
  const parenIdx = clause.indexOf('(');

  if (parenIdx < 0) {
    const property = clause.trim();
    if (property.length === 0) {
      throw new ExpandParseError('Empty navigation property name in $expand', basePosition);
    }
    return { property, options: {} };
  }

  const property = clause.slice(0, parenIdx).trim();
  if (property.length === 0) {
    throw new ExpandParseError('Empty navigation property name in $expand', basePosition);
  }

  // Find matching closing paren
  let depth = 0;
  let closeIdx = -1;
  for (let i = parenIdx; i < clause.length; i++) {
    if (clause[i] === '(') depth++;
    else if (clause[i] === ')') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }

  if (closeIdx < 0) {
    throw new ExpandParseError(`Unmatched parenthesis in $expand clause: "${clause}"`, basePosition + parenIdx);
  }

  const optionsStr = clause.slice(parenIdx + 1, closeIdx);
  const options = optionsStr.length > 0
    ? parseExpandOptions(optionsStr, basePosition + parenIdx + 1)
    : {};

  return { property, options };
};

/**
 * Parse comma-separated expand clauses at depth 0.
 *
 * This is the recursive entry point — called both from the top-level
 * `parseExpand()` and from nested `$expand=...` options.
 */
const parseExpandClauses = (input: string, basePosition: number): ReadonlyArray<ExpandExpression> => {
  const parts = splitAtDepthZero(input, ',');
  return parts.map(part => parseExpandClause(part, basePosition));
};

/**
 * Parse an OData $expand expression string into a structured AST.
 *
 * @param expand - Raw $expand query option value
 * @returns Array of parsed expand expressions
 * @throws ExpandParseError on invalid syntax
 *
 * @example
 * ```ts
 * import { parseExpand } from "@reso-standards/odata-expression-parser";
 *
 * const result = parseExpand("Media($select=MediaURL),Rooms($expand=Listing)");
 * // [
 * //   { property: "Media", options: { $select: "MediaURL" } },
 * //   { property: "Rooms", options: { $expand: [{ property: "Listing", options: {} }] } }
 * // ]
 * ```
 */
export const parseExpand = (expand: string): ReadonlyArray<ExpandExpression> => {
  const trimmed = expand.trim();
  if (trimmed.length === 0) return [];
  return parseExpandClauses(trimmed, 0);
};
