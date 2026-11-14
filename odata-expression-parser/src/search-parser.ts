/**
 * OData `$search` expressions (OData 4.01 URL Conventions, Section 5.1.7; the ABNF `searchExpr` rule).
 *
 * Words and double-quoted phrases, combined with `NOT`, `AND` (or a space) and `OR`, grouped with parentheses, and
 * evaluated in the order grouping, NOT, AND, OR (OData 4.01 Protocol, `$search`). The keywords are operators only where
 * the grammar puts them: `AND` and `OR` between two expressions, `NOT` before one; elsewhere, and in lowercase, they are
 * words. A single-quoted string is an incomplete expression sent for type-ahead, with single quotes doubled; it is read
 * as one phrase.
 *
 * What a word or phrase matches is the service's to define; this module only reads the expression.
 */

export type SearchExpression =
  | { readonly type: 'term'; readonly value: string; readonly phrase: boolean }
  | { readonly type: 'not'; readonly operand: SearchExpression }
  | { readonly type: 'and' | 'or'; readonly left: SearchExpression; readonly right: SearchExpression };

const SEARCH_PARSE_ERROR = 'SearchParseError';

/** A malformed `$search` expression: the client's error. */
export const searchParseError = (message: string): Error => Object.assign(new Error(message), { name: SEARCH_PARSE_ERROR });

export const isSearchParseError = (err: unknown): err is Error => err instanceof Error && err.name === SEARCH_PARSE_ERROR;

type Token =
  | { readonly kind: 'open' }
  | { readonly kind: 'close' }
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'phrase'; readonly value: string };

/** Characters that end a word: whitespace, parentheses, double quotes and the semicolon (the ABNF's comment). */
const ENDS_WORD = /[\s()";]/;

const tokenize = (input: string): ReadonlyArray<Token> => {
  const tokens: Token[] = [];
  let at = 0;
  while (at < input.length) {
    const char = input[at];
    if (/\s/.test(char)) {
      at += 1;
    } else if (char === '(' || char === ')') {
      tokens.push({ kind: char === '(' ? 'open' : 'close' });
      at += 1;
    } else if (char === '"') {
      const end = input.indexOf('"', at + 1);
      if (end < 0) throw searchParseError(`Unterminated phrase in $search: ${input.slice(at)}`);
      const value = input.slice(at + 1, end);
      if (value === '') throw searchParseError('Empty phrase in $search');
      tokens.push({ kind: 'phrase', value });
      at = end + 1;
    } else if (char === ';') {
      throw searchParseError(`";" is not allowed in $search: ${input}`);
    } else {
      const start = at;
      while (at < input.length && !ENDS_WORD.test(input[at])) at += 1;
      tokens.push({ kind: 'word', value: input.slice(start, at) });
    }
  }
  return tokens;
};

const isKeyword = (token: Token | undefined, keyword: 'AND' | 'OR' | 'NOT'): boolean => token?.kind === 'word' && token.value === keyword;

/** Parse a `$search` expression. Throws an error `isSearchParseError` recognizes when it is malformed. */
export const parseSearch = (input: string): SearchExpression => {
  const trimmed = input.trim();
  if (trimmed === '') throw searchParseError('Empty $search expression');

  // The incomplete form: an OData string literal, single quotes doubled inside. It may be empty: a type-ahead box with
  // nothing typed yet.
  if (trimmed.startsWith("'")) {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) throw searchParseError(`Unterminated $search literal: ${trimmed}`);
    const inner = trimmed.slice(1, -1);
    if (inner.replace(/''/g, '').includes("'"))
      throw searchParseError(`A single quote inside a $search literal must be doubled: ${trimmed}`);
    return { type: 'term', value: inner.replace(/''/g, "'"), phrase: true };
  }

  const tokens = tokenize(trimmed);
  let at = 0;
  const peek = (offset = 0): Token | undefined => tokens[at + offset];
  // An expression can start at a token that is there and is not a closing parenthesis.
  const startsExpression = (offset: number): boolean => peek(offset) !== undefined && peek(offset)?.kind !== 'close';

  const parseOr = (): SearchExpression => {
    let left = parseAnd();
    while (isKeyword(peek(), 'OR') && startsExpression(1)) {
      at += 1;
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  };

  const parseAnd = (): SearchExpression => {
    let left = parseNot();
    for (;;) {
      const next = peek();
      if (next === undefined || next.kind === 'close') return left;
      if (isKeyword(next, 'OR') && startsExpression(1)) return left;
      if (isKeyword(next, 'AND') && startsExpression(1)) at += 1;
      left = { type: 'and', left, right: parseNot() };
    }
  };

  const parseNot = (): SearchExpression => {
    if (isKeyword(peek(), 'NOT') && startsExpression(1)) {
      at += 1;
      return { type: 'not', operand: parseNot() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): SearchExpression => {
    const token = peek();
    if (token === undefined) throw searchParseError(`Incomplete $search expression: ${trimmed}`);
    at += 1;
    if (token.kind === 'open') {
      const inner = parseOr();
      if (peek()?.kind !== 'close') throw searchParseError(`Unmatched "(" in $search: ${trimmed}`);
      at += 1;
      return inner;
    }
    if (token.kind === 'close') throw searchParseError(`Unmatched ")" in $search: ${trimmed}`);
    return { type: 'term', value: token.value, phrase: token.kind === 'phrase' };
  };

  const expression = parseOr();
  if (at < tokens.length) throw searchParseError(`Unmatched ")" in $search: ${trimmed}`);
  return expression;
};
