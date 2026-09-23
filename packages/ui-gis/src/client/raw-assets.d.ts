/**
 * \`?raw\` imports: the file's text, as a string.
 *
 * The client preset resolves them (see \`rawAssetPlugin\` in tsdown.client.ts);
 * this declaration is only so TypeScript knows the shape. It exists because a
 * Web Worker cannot import a plugin chunk, so worker code has to travel inside
 * one as text.
 */
declare module '*?raw' {
  const text: string
  export default text
}
