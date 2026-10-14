/**
 * @reso-standards/odata-expression-parser
 *
 * OData expression parsers for $filter and $expand. Tokenizes and parses
 * expression strings into typed ASTs (discriminated unions). Zero runtime
 * dependencies.
 *
 * Used by both the OData client (query validation) and the reference server
 * ($filter -> SQL WHERE translation, $expand -> recursive navigation resolution).
 *
 * Inspired by Apache Olingo's UriParser / ExpressionParser.
 *
 * @example
 * ```ts
 * import { parseFilter, parseExpand } from "@reso-standards/odata-expression-parser";
 *
 * const filterAst = parseFilter("ListPrice gt 200000 and City eq 'Austin'");
 * const expandAst = parseExpand("Media($select=MediaURL),Rooms($expand=Listing)");
 * ```
 */

export { parseFilter, ParseError, LexerError } from './parser.js';
export { astToFilterString } from './serializer.js';
export { tokenize } from './lexer.js';
export { parseExpand, ExpandParseError } from './expand-parser.js';
export type {
  FilterExpression,
  ComparisonExpr,
  LogicalExpr,
  NotExpr,
  ArithmeticExpr,
  FunctionCallExpr,
  LiteralExpr,
  PropertyExpr,
  LambdaExpr,
  CollectionExpr,
  ComparisonOperator,
  LogicalOperator,
  ArithmeticOperator,
  FilterFunctionName,
  LiteralDataType,
  Token,
  TokenType
} from './types.js';
export type {
  ExpandExpression,
  ExpandQueryOptions
} from './expand-types.js';
