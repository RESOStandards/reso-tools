/**
 * OData $expand expression AST types.
 *
 * Represents parsed $expand options as a tree of navigation property
 * expansions, each with optional nested query options (including recursive
 * $expand for multi-level expansion).
 *
 * @see OData 4.01 §5.1.3 — System Query Option $expand
 */

// ---------------------------------------------------------------------------
// Expand query options — the subset of system query options allowed inside
// parenthesized $expand options.
// ---------------------------------------------------------------------------

export interface ExpandQueryOptions {
  readonly $select?: string;
  readonly $filter?: string;
  readonly $orderby?: string;
  readonly $top?: number;
  readonly $skip?: number;
  readonly $count?: boolean;
  readonly $expand?: ReadonlyArray<ExpandExpression>;
  readonly $levels?: number | 'max';
}

// ---------------------------------------------------------------------------
// A single expand clause — one navigation property with optional nested
// query options.
// ---------------------------------------------------------------------------

export interface ExpandExpression {
  readonly property: string;
  readonly options: ExpandQueryOptions;
}
