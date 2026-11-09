/**
 * A fixed order for every page of a collection, whatever the data.
 *
 * Server-driven paging cuts a collection into pages by position, so it needs every page to see the rows in the same
 * order. Sorting on a field with ties does not give that: rows tied on the sort column may come back in a different
 * order on each query, so a row lands on two pages and another on none. Web API Core 2.1.0's server-driven paging test
 * caught exactly that on Postgres, paging by a ModificationTimestamp that many records shared. With no `$orderby` at
 * all, a SQL database promises no order whatever.
 *
 * The resource's key is unique, so it is always the last sort column: the client's order holds, and ties within it,
 * or the whole collection when the client asks for no order, fall to the key.
 */

/** The sort columns with the key last, unless the client already sorts on the key, which is then already unique. */
export const withKeyLast = (columns: ReadonlyArray<string>, keyColumn: string): ReadonlyArray<string> =>
  columns.some(column => column === keyColumn || column.startsWith(`${keyColumn} `)) ? columns : [...columns, `${keyColumn} ASC`];

/** A SQL ORDER BY clause from the client's parsed columns (none when it asked for no order), key last. */
export const stableOrderBy = (parsedColumns: string, keyColumn: string): string =>
  `ORDER BY ${withKeyLast(parsedColumns === '' ? [] : parsedColumns.split(', '), keyColumn).join(', ')}`;
