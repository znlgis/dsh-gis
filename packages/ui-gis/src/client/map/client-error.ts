/**
 * A client-side failure the card can NAME.
 *
 * The browser half has no access to the host's `GisError` (importing gis-core
 * would drag a Node package into the client graph), so the taxonomy is repeated
 * here in miniature: a code that ends up in the issue list, a message a user can
 * read, and nothing else. Codes are matched by value, never by class identity.
 */
export class GisClientError extends Error {
  /**
   * @param code - stable machine-readable code, shown in the issue list.
   * @param message - what went wrong, for a person.
   * @param hint - what to try instead, when there is something to try.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'GisClientError'
  }
}
