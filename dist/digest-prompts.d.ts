import type { ConversationExchange } from './types.js';
import type { DigestEntry } from './digest-db.js';
export interface BuiltPrompt {
    prompt: string;
    /** Mark number used in the prompt -> exchange id. */
    marks: Map<number, string>;
}
export declare function buildSessionPrompt(exchanges: ConversationExchange[]): BuiltPrompt;
export declare function buildCompressPrompt(entries: DigestEntry[], tier: 'day' | 'week'): BuiltPrompt;
