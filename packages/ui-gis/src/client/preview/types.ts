/**
 * The slice of the host's document-preview contract this plugin touches.
 *
 * Declared STRUCTURALLY rather than imported: the definition type lives in
 * another plugin's client half, and a value or type import from there would make
 * our bundle depend on that package's identity. The shape is the published one
 * (design L1 quotes it from the registry), and \`register\` validates it at
 * runtime -- an out-of-band change surfaces as a registration error, not as a
 * silently ignored preview.
 */
export interface DocumentPreviewDefinition {
  /** Unique implementation name, also used as the document slot key. */
  readonly id: string
  /** File suffixes without a leading dot; compound suffixes are accepted. */
  readonly extensions: readonly string[]
  /** Suffixes whose bytes are not readable text; every entry must appear in \`extensions\`. */
  readonly binaryExtensions?: readonly string[]
  /** External implementations win over product ones; defaults to extension. */
  readonly priority?: 'builtin' | 'extension'
  /** Localized implementation label. */
  readonly title: () => string
  /** Content delivery mode supplied by the document owner. */
  readonly loading: 'text-pages' | 'bytes-complete' | 'renderer'
  /** Whether the implementation consumes the document's wrap preference. */
  readonly wrap?: boolean
}

/** The document registry this plugin registers with (provided by the preview plugin). */
export interface DocumentPreviewRegistry {
  /**
   * @param definition - the implementation to add.
   * @returns the exact disposer that unregisters it.
   */
  register(definition: DocumentPreviewDefinition): () => void
}
