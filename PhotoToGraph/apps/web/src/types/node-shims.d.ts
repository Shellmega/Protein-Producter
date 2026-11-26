/**
 * Minimal ambient declarations for the Node built-ins used by test-only code.
 *
 * The web app has no `@types/node` dependency (it is a browser app); the
 * contract replay test reads the frozen contract copies from disk, so it needs
 * these two modules. Vitest runs the real Node implementations.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
