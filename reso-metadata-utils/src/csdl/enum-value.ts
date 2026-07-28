/**
 * Enum value decoding — the shared, one-and-only decoder that turns a raw enum field value into its
 * native member elements (the member names declared in the provider's metadata). Every consumer
 * (the SDK's enum abstraction, the Core cert, the web-client display) delegates here rather than
 * hand-rolling comma-splitting or bit math, which is where divergent, subtly-wrong decoders creep in.
 */

import type { CsdlEnumType } from './types.js';

/**
 * Decode a raw *scalar* enum value into its native member elements — the member names as declared on
 * the `CsdlEnumType`. Handles the two scalar wire forms an enum value arrives in:
 *
 *   single member name    `"Active"`  → `["Active"]`
 *   comma-joined names     `"A,B"`     → `["A", "B"]`     (IsFlags string form)
 *   integer bitmask        `3`         → `["A", "B"]`     (IsFlags numeric form — Microsoft / OData
 *                                                          tooling emits this; `A=1, B=2` ⇒ `3` sets both)
 *
 * Bitmask decode needs the numeric member values, which live **only** on `CsdlEnumType`
 * (`CsdlEnumMember.value`) — the serialized MetadataReport stores `member.name` and drops the value,
 * so always decode against the parsed schema, never the report. Uses `BigInt` so flags enums wider
 * than 31 members (an `Int64` underlying type) do not truncate the way 32-bit `&` would. The value-0
 * "None" member is excluded (it is a subset of every input), and members with no declared value are
 * skipped.
 *
 * Assumptions and boundaries (documented so a future reviewer sees the "why"):
 *  - Bitmask decode assumes **power-of-two** member values, which is what a well-formed IsFlags enum
 *    declares. An enum marked `IsFlags="true"` with sequential values is out of spec and is caught by
 *    the DD shape gate — this decoder does not try to rescue it.
 *  - A bit with no matching member is **unrepresentable** (there is no name for it) and is dropped.
 *  - Comma-name tokens are returned **as sent** (trimmed, non-empty), *not* filtered against the
 *    member set — membership/conformance is a separate concern (`isMember`), so display never silently
 *    loses a value the provider actually returned. Callers that want only conformant members validate
 *    the result themselves.
 *  - Collection representations (`Collection(Edm.String)` / `Collection(EnumType)`) arrive as JSON
 *    arrays, not scalars, and are handled by the caller; this is the scalar (single / IsFlags) decoder.
 */
export const decodeFlagsValue = (
  enumType: CsdlEnumType,
  raw: string | number | null | undefined,
): ReadonlyArray<string> => {
  // Off-contract inputs must yield [] — never a phantom member. An absent enum field arrives as
  // `null`/`undefined` across the JSON boundary; a non-integer / NaN / Infinity / precision-unsafe
  // number is not a real enum value. Without these guards each would fall through to
  // `String(raw).split(',')` and manufacture a fake member name (e.g. `null` → ["null"], `3.5` →
  // ["3.5"]). An unsafe integer (> 2^53) has already lost precision at JSON-parse time, so BigInt
  // cannot recover it — reject rather than silently decode the wrong number. Wide (Int64) bitmasks
  // must therefore arrive as strings (OData IEEE754Compatible serializes Int64 as a string).
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) return [];

  const trimmed = typeof raw === 'string' ? raw.trim() : raw;

  // A number (now known to be a safe integer) or a bare non-negative all-digits string is the bitmask
  // form. Enum member names are OData SimpleIdentifiers (they start with a letter/underscore), so an
  // all-digits token is never a name — the two forms are unambiguous.
  const isBitmask = typeof trimmed === 'number' || /^\d+$/.test(trimmed);

  if (isBitmask) {
    let bits: bigint;
    try {
      bits = BigInt(trimmed);
    } catch {
      return [];
    }
    if (bits < 0n) return [];
    return enumType.members
      .filter((m) => {
        if (m.value === undefined) return false;
        let memberBit: bigint;
        try {
          memberBit = BigInt(m.value);
        } catch {
          return false;
        }
        // Only atomic power-of-two flags participate in bit decomposition: the value-0 "None" and any
        // composite (non-power-of-two) convenience member are excluded, so a bitmask decodes to the
        // atomic member set a well-formed IsFlags enum declares and never over-reports a combined
        // member. `x & (x - 1) === 0` is the power-of-two test.
        return memberBit > 0n && (memberBit & (memberBit - 1n)) === 0n && (bits & memberBit) === memberBit;
      })
      .map((m) => m.name);
  }

  // Comma-joined name form (also covers a lone scalar name → a one-element result).
  return String(trimmed)
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
};
