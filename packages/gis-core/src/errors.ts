/**
 * The GIS error taxonomy (design appendix D).
 *
 * Every domain failure carries a stable code so the model can tell a DATA
 * problem from an ENVIRONMENT problem, and so tests can assert on the code
 * rather than on prose that will be reworded.
 */

/** Every code this plugin may raise. */
export const GIS_ERROR_CODES = [
  // environment
  'GDAL_UNAVAILABLE',
  'GDB_DRIVER_MISSING',
  'QGIS_UNAVAILABLE',
  // dataset lookup
  'DATASET_NOT_FOUND',
  'DATASET_UNREADABLE',
  'UNSUPPORTED_FORMAT',
  'LAYER_AMBIGUOUS',
  'LAYER_NOT_FOUND',
  // coordinate reference systems
  'CRS_UNKNOWN',
  'CRS_UNSUPPORTED',
  'CRS_MISMATCH',
  // data quality
  'ENCODING_UNDECIDED',
  'GEOMETRY_INVALID',
  'PARSE_FAILED',
  'CRS_AMBIGUOUS',
  // limits
  'LIMIT_EXCEEDED',
  'CACHE_QUOTA_EXCEEDED',
  // network sources (T3.2+): a database is a dataset whose failures are its own
  'PG_CONNECT_FAILED',
  'PG_QUERY_FAILED',
  'SQL_TIMEOUT',
] as const

/** One member of the taxonomy. */
export type GisErrorCode = (typeof GIS_ERROR_CODES)[number]

/**
 * A domain failure that carries a stable code.
 *
 * `message` is what the model reads: one actionable line. `hint` is the
 * operator's fix, when there is one.
 */
export class GisError extends Error {
  /** Stable machine code from {@link GIS_ERROR_CODES}. */
  readonly code: GisErrorCode

  /** What a human should do about it, when that is knowable. */
  readonly hint: string | undefined

  /**
   * @param code - stable taxonomy member.
   * @param message - one actionable line for the model.
   * @param hint - operator-facing fix, if any.
   */
  constructor(code: GisErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'GisError'
    this.code = code
    this.hint = hint
  }
}

/**
 * Whether a value is a {@link GisError}.
 * @param value - candidate.
 * @returns true when it carries the stable code field.
 */
export function isGisError(value: unknown): value is GisError {
  return value instanceof GisError
}
