import type { ChatMessage } from "./api/chat.js";
import type { InboxMessage } from "./api/mail.js";
export interface LocalDecryptProvider {
    mailMessage?(messageID: string): Promise<Partial<InboxMessage> | null>;
    chatMessage?(sessionID: string, messageID: string): Promise<Partial<ChatMessage> | null>;
}
export interface LocalAWDecryptOptions {
    workdir: string;
    awCommand?: string;
}
export declare function createLocalAWDecryptProvider(options: LocalAWDecryptOptions): LocalDecryptProvider;
