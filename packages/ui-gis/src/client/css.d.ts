/** CSS Modules: the preset compiles these into a hashed class map. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

/** Plain stylesheet import: the preset injects a plugin-owned style tag. */
declare module '*.css' {}

/** Compiled stylesheet text, for a plugin-owned lifecycle effect. */
declare module '*.css?inline' {
  const css: string
  export default css
}
