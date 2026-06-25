/** Checks whether a field type is an enum reference (not a primitive Edm type). */
// TODO(#222): duplicate of reso-common's isEnumType — consolidate to one shared helper and
// prefer the precomputed isEnumeration flag where a field is in hand. See reso-tools #222.
export const isEnumType = (type: string): boolean => !type.startsWith('Edm.');

/** Checks if an Edm type is numeric. */
export const isNumericEdmType = (type: string): boolean =>
  ['Edm.Decimal', 'Edm.Int64', 'Edm.Int32', 'Edm.Int16', 'Edm.Double', 'Edm.Single', 'Edm.Byte'].includes(type);

/** Checks if an Edm type is an integer (no decimals allowed). */
export const isIntegerEdmType = (type: string): boolean => ['Edm.Int64', 'Edm.Int32', 'Edm.Int16', 'Edm.Byte'].includes(type);
