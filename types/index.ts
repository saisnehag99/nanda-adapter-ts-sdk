export class Message {
    constructor(
        public message_id: string,
        public conversation_id: string,
        public content: TextContent,
        public role: MessageRole
    ) {}
}

export class TextContent {
    type = 'text';
    constructor(public text: string) {}
}

export enum MessageRole {
    USER = 'user',
    AGENT = 'agent',
}

export interface Metadata {
    custom_fields?: Record<string, any>;
}
