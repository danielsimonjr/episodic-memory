import { ConversationExchange } from './types.js';
/**
 * Parse a conversation transcript into exchanges.
 *
 * The function reads the file to detect its format. A Codex transcript uses the Codex reader.
 * Every other transcript uses the Claude reader.
 *
 * @param filePath the transcript file to read
 * @param projectName the project name to store on each exchange
 * @param archivePath the archive path to store on each exchange
 */
export declare function parseConversation(filePath: string, projectName: string, archivePath: string): Promise<ConversationExchange[]>;
/**
 * Parse a conversation file and name its project.
 *
 * The project name is the name of the folder that holds the file, or `unknown` when that name is empty.
 * The archive path of each exchange is the file path.
 */
export declare function parseConversationFile(filePath: string): Promise<{
    project: string;
    exchanges: ConversationExchange[];
}>;
