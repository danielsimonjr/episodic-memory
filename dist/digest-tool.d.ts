import type { DigestInput } from './mcp-schemas.js';
/** One-line, redacted, capped note text. */
export declare function normalizeHandoff(note: string): string;
/** Behavior of the `digest` MCP tool. Exactly one of expand, handoff, query, or the default view runs. */
export declare function digestToolText(params: DigestInput): string;
