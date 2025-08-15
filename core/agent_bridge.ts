// const sdk = await import('@a2a-js/sdk');
// console.log(sdk);

// import { A2AClient } from '@a2a-js/sdk/dist/client';
// import { A2AServer, Message, TextContent, MessageRole, Metadata } from '@a2a-js/sdk/dist/server';

// import * as server from '@a2a-js/sdk/server';
// console.log(server);

import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer';
import { URL } from 'url';
import express from 'express';
import { MCPClient } from './mcp_utils.ts';  
import { Anthropic, APIStatusError } from 'anthropic';
import { A2AClient } from '@a2a-js/sdk/client';
import { A2AExpressApp } from '@a2a-js/sdk/server/express';
import { Message, TextPart } from '@a2a-js/sdk';

// MessageRole, Metadata
// wrong imports below
// import { A2AClient, A2AServer, Message, TextContent, MessageRole, Metadata, run_server } from '@a2a-js/sdk'; //TODO
// import type { Message } from '@a2a-js/sdk';

// Utility types and interfaces
type Optional<T> = T | undefined | null;

// Set API key through environment variable or directly in the code
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'your key';

// Toggle for message improvement feature
const IMPROVE_MESSAGES = (process.env.IMPROVE_MESSAGES ?? 'true').toLowerCase() === 'true';

// Helper: Get agent configuration from env
function get_agent_id(): string {
    /*Get AGENT_ID dynamically from environment variables*/
    return process.env.AGENT_ID || "default";
}

const PORT = parseInt(process.env.PORT || "6000");
const TERMINAL_PORT = parseInt(process.env.TERMINAL_PORT || "6010");
const LOCAL_TERMINAL_URL = `http://localhost:${TERMINAL_PORT}/a2a`;

// UI client support
const UI_MODE = (process.env.UI_MODE ?? 'true').toLowerCase() === 'true';
const UI_CLIENT_URL = process.env.UI_CLIENT_URL || '';
const registeredUIClients = new Set<string>();
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Logging directory
const LOG_DIR = process.env.LOG_DIR || 'conversation_logs';
fs.mkdirSync(LOG_DIR, { recursive: true });

// System prompts
const SYSTEM_PROMPTS: Record<string, string> = {
    default: "You are Claude assisting a user (Agent). Assume the messages you get are part of a conversation with other agents. Help the user communicate effectively with other agents."};

const IMPROVE_MESSAGE_PROMPTS: Record<string, string> = {
    default: "Improve the following message to make it more clear, compelling, and professional without changing the core content or adding fictional information. Keep the same overall meaning but enhance the phrasing and structure. Don't make it too verbose - keep it concise but impactful. Return only the improved message without explanations or introductions."
};

const SMITHERY_API_KEY = process.env.SMITHERY_API_KEY || 'bfcb8cec-9d56-4957-8156-bced0bfca532';

export function get_registry_url(): string {
    /*Get the registry URL from file or use default*/
    const filePath = path.resolve('registry_url.txt');

    try {
        if (fs.existsSync(filePath)) {
            const registryUrl = fs.readFileSync(filePath, 'utf-8').trim();
            console.log(`Using registry URL from file: ${registryUrl}`);
            return registryUrl;
        }
    } catch (e) {
        console.log(`Error reading registry URL from file: ${e}`);
    }

    // Default if file doesn't exist
    const defaultUrl = "https://chat.nanda-registry.com:6900";
    console.log(`Using default registry URL: ${defaultUrl}`);
    return defaultUrl;
}

export async function register_with_registry(
    agentId: string,
    agentUrl: string,
    apiUrl: string
): Promise<boolean> {
    /*Register the agent with the registry*/
    const registryUrl = get_registry_url();

    try {
        const data = {
            agent_id: agentId,
            agent_url: agentUrl,
            api_url: apiUrl,
        };

        console.log(`Registering agent ${agentId} with URL ${agentUrl} at registry ${registryUrl}...`);
        const response = await axios.post(`${registryUrl}/register`, data);
        if (response.status === 200) {
            console.log(`Agent ${agentId} registered successfully`);
            return true;
        } else {
            console.error(`Failed to register agent: ${response.data}`);
            return false;
        }
    } catch (error) {
        console.error(`Error registering agent: ${(error as Error).message}`);
        return false;
    }
}

export async function lookup_agent(agentId: string): Promise<string | null> {
    /*Look up an agent's URL in the registry*/
    const registryUrl = get_registry_url();

    try {
        console.log(`Looking up agent ${agentId} in registry ${registryUrl}...`);
    
        const response = await axios.get(`${registryUrl}/lookup/${agentId}`);

        if (response.status === 200) {
            const agentUrl = response.data.agent_url;
            console.log(`Found agent ${agentId} at URL: ${agentUrl}`);
            return agentUrl;
        }

        console.log(`Agent ${agentId} not found in registry`);
        return null;
    } catch (error) {
        console.error(`Error looking up agent ${agentId}: ${(error as Error).message}`);
        return null;
    }
}

export async function list_registered_agents(): Promise<any[] | null> {
    /*Get a list of all registered agents from the registry*/
    const registryUrl = get_registry_url();

    try {
        console.log(`Requesting list of agents from registry ${registryUrl}...`);

        const response = await axios.get(`${registryUrl}/list`);

        if (response.status === 200) {
            const agents = response.data;
            return agents;
        }
        console.log('Failed to get list of agents from registry');
        return null;
    } catch (error) {
        console.error(`Error getting list of agents: ${(error as Error).message}`);
        return null;
    }
}

export function log_message(
    task_id: string,
    file_path: string,
    source: string,
    message_text: string
): void {
    /*Log a message to the conversation log file */
    const timestamp = new Date().toISOString();
    const log_entry = {
        timestamp,
        task_id: task_id,
        path: file_path,
        source,
        message: message_text,
    };
    const log_filename = path.join(LOG_DIR, `conversation_${task_id}.jsonl`);

    try {
        fs.appendFileSync(log_filename, JSON.stringify(log_entry) + '\n');
        console.log(`Logged message from ${source} in conversation ${task_id}`);
    } catch (error) {
        console.error(`Error logging message: ${(error as Error).message}`);
    }
}

export async function call_claude(
  prompt: string,
  additional_context: string,
  task_id: string,
  current_path: string,
  system_prompt?: string
): Promise<string | null> {
    /*Wrapper that never raises: returns text or None on failure.*/
    const agent_id = get_agent_id();

    try {
        const system = system_prompt || SYSTEM_PROMPTS['default'];

        let full_prompt = prompt;
        if (additional_context && additional_context.trim()) {
            full_prompt = `ADDITIONAL CONTEXT FROM USER: ${additional_context}\n\nMESSAGE: ${prompt}`;
        }

        console.log(`Agent ${agent_id}: Calling Claude with prompt: ${full_prompt.slice(0, 50)}...`);

        const resp = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 512,
            messages: [{ role: 'user', content: full_prompt }],
            system,
        });
        const response_text = resp.content[0].text;

        log_message(task_id, current_path, `Claude ${agent_id}`, response_text);

        return response_text;
    } catch (e: any) {
        if (e instanceof APIStatusError) {
            console.error(`Agent ${agent_id}: Anthropic API error:`, e.status_code, e.message);
            if (String(e).includes('credit balance is too low')) {
                return `Agent ${agent_id} processed (API credit limit reached): ${prompt}`;
            }
        } else {
            console.error(`Agent ${agent_id}: Anthropic SDK error:`, e.stack || e.message);
        }
        return null;
    }
}

export async function call_claude_direct(
    message_text: string,
    system_prompt?: string
    ): Promise<string | null> {
    /**
     * Wrapper that never throws: returns text or null on failure.
     */
    let agent_id = "";
    try {
        const full_prompt = `MESSAGE: ${message_text}`;

        agent_id = get_agent_id();
        console.log(`Agent ${agent_id}: Calling Claude with prompt: ${full_prompt.slice(0, 50)}...`);

        const resp = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 512,
            messages: [{ role: "user", content: full_prompt }],
            system: system_prompt,
        });
        const response_text = resp.content?.[0]?.text || "";
        return response_text;
    } catch (e: any) {
        if (e.status && e.message) {
            console.error(`Agent ${agent_id}: Anthropic API error:`, e.status, e.message);
            if (String(e).includes("credit balance is too low")) {
                return `Agent ${agent_id} processed (API credit limit reached): ${message_text}`;
            }
        } else {
            console.error(`Agent ${agent_id}: Anthropic SDK error:`, e);
            console.error(e.stack);
        }
        return null;
    }
}

export async function improve_message(
    message_text: string,
    task_id: string,
    current_path: string,
    additional_prompt?: string
): Promise<string> {
    /*Improve a message using Claude before forwarding it to the other party.*/
    // If improvement is disabled, just return the original message
    if (!IMPROVE_MESSAGES) {
        return message_text;
    }

    try {
        const system_prompt = additional_prompt
            ? additional_prompt + IMPROVE_MESSAGE_PROMPTS["default"]
            : IMPROVE_MESSAGE_PROMPTS["default"];

        // Call Claude to improve the message
        const improved_message = await call_claude(
            message_text,
            "",
            task_id,
            current_path,
            system_prompt
        );

        // Use improved message if available, otherwise fall back to original
        return improved_message || message_text;
    } catch (e) {
        console.error(`Error improving message: ${e}`);
        return message_text;
    }
}

interface CustomMetadata {
  [key: string]: string | number | boolean;
}

export async function send_to_terminal(
    text: string,
    terminal_url: string,
    task_id: string,
    metadata?: Record<string, unknown>
): Promise<boolean> {
    /*Send a message to a terminal*/
    try {
        console.log(`Sending message to ${terminal_url}: ${text.slice(0, 50)}...`);
        
        const terminal = new A2AClient(terminal_url);

        const message: Message = {
            kind: "message",
            role: "user",
            messageId: uuidv4(),
            parts: [{ kind: "text", text }],
            taskId: task_id,
            metadata: metadata ? { custom_fields: metadata } : {}
        }

        for await (const event of terminal.sendMessageStream({ message: message })) {
            // console.log(event); // handle streaming response
        }

        return true;
    } catch (e) {
        console.error(`Error sending to terminal ${terminal_url}: ${e}`);
        return false;
    }
}

export async function send_to_ui_client(
    message_text: string, 
    from_agent: string, 
    task_id: string
): Promise<boolean> {
    /*Read UI_CLIENT_URL dynamically to get the latest value*/
    const ui_client_url = process.env.UI_CLIENT_URL || "";
    console.log(`🔍 Dynamic UI_CLIENT_URL: '${ui_client_url}'`);

    if (!ui_client_url) {
        console.log("No UI client URL configured. Cannot send message to UI client");
        return false;
    }

    try {
        console.log(`Sending message to UI client: ${message_text.slice(0, 50)}...`);

        const response = await axios.post(
            ui_client_url,
            {
                message: message_text,
                from_agent: from_agent,
                task_id: task_id,
                timestamp: new Date().toISOString()
            },
            {
                timeout: 10000, // 10 seconds
            }
        );

        if (response.status === 200) {
            console.log(`Message sent to UI client successfully`);
            return true;
        } else {
            console.error(`Failed to send message to UI client: ${response.data}`);
            return false;
        }
    } catch (error) {
        console.error(`Error sending message to UI client: ${(error as Error).message}`);
        return false;
    }
}

export async function send_to_agent(
    target_agent_id: string,
    message_text: string,
    task_id: string,
    metadata?: Record<string, any>
): Promise<string> {
    /*Send a message to another agent via their bridge*/
    // Look up the agent in the registry
    const agent_url = await lookup_agent(target_agent_id);
    if (!agent_url) {
        return `Agent ${target_agent_id} not found in registry`;
    }

    try {
        let target_bridge_url: string;

        if (!agent_url.endsWith('/a2a')) {
            target_bridge_url = `${agent_url}/a2a`;
            console.log(`Adding /a2a to URL: ${target_bridge_url}`);
        } else {
            target_bridge_url = agent_url;
            console.log(`URL already includes /a2a: ${target_bridge_url}`);
        }

        console.log(`Sending message to ${target_agent_id} at ${target_bridge_url}`);

        const agent_id = get_agent_id();
        const formatted_message = `__EXTERNAL_MESSAGE__
__FROM_AGENT__${agent_id}
__TO_AGENT__${target_agent_id}
__MESSAGE_START__
${message_text}
__MESSAGE_END__`;

        // Prepare metadata
        let send_metadata: Record<string, any> | null = null;
        try {
            send_metadata = {
                agent_id: agent_id,
                task_id: task_id,
                timestamp: new Date().toISOString(),
                ...(metadata || {})
            };
            console.log('Custom Fields being sent:', send_metadata);
        } catch (e) {
            send_metadata = null;
            console.error("Warning: Could not set metadata, but continuing with message format");
        }

        // Send message
        const bridge_client = new A2AClient(target_bridge_url);
        const message: Message = {
            kind: "message",
            role: "user",
            messageId: uuidv4(),
            parts: [{ kind: "text", text: formatted_message }],
            taskId: task_id,
            metadata: send_metadata ? { custom_fields: send_metadata } : {}
        }
        await bridge_client.sendMessage({ message: message });

        return `Message sent to ${target_agent_id}`;
    } catch (e: any) {
        console.error(`Error sending message to ${target_agent_id}:`, e);
        return `Error sending message to ${target_agent_id}: ${e.message || e}`;
    }
}

export async function get_mcp_server_url(
    requested_registry: string,
    qualified_name: string
): Promise<[string, Record<string, any>, string] | null> {
    try {
        const registry_url = get_registry_url();
        const endpoint_url = `${registry_url}/get_mcp_registry`;

        console.log(`Querying MCP registry endpoint: ${endpoint_url} for ${qualified_name}`);

        const response = await axios.get(endpoint_url, {
            params: {
                registry_provider: requested_registry,
                qualified_name: qualified_name
            }
        });

        if (response.status === 200) {
            const result = response.data;
            const endpoint: string | undefined = result.endpoint;
            const config = result.config;
            const config_json = typeof config === 'string' ? JSON.parse(config) : config;
            const registry_name: string | undefined = result.registry_provider;

            if (endpoint && registry_name) {
                console.log(`Found MCP server URL for ${qualified_name}: ${endpoint} && ${JSON.stringify(config_json)}`);
                return [endpoint, config_json, registry_name];
            } else {
                console.log(`Incomplete MCP server data for ${qualified_name}`);
                return null;
            }
        } else {
            console.log(`No MCP server found for qualified_name: ${qualified_name} (Status: ${response.status})`);
            return null;
        }
    } catch (err) {
        console.error(`Error querying MCP server URL:`, err);
        return null;
    }
}

export async function form_mcp_server_url(
    url: string,
    config: Record<string, any>,
    registry_name: string
): Promise<string | null> {
    /*
    Form the MCP server URL based on the URL and config.
    
    Args:
        url (str): The URL of the MCP server
        config (dict): The config of the MCP server
        registry_name (str): The name of the registry provider
        
    Returns:
        Optional[str]: The mcp server URL if smithery api key is available, otherwise None
    */
    try {
        let mcp_server_url: string;

        if (registry_name === "smithery") {
            console.log("🔑 Using SMITHERY_API_KEY:", SMITHERY_API_KEY);

            const smithery_api_key = SMITHERY_API_KEY;
            if (!smithery_api_key) {
                console.log("❌ SMITHERY_API_KEY not found in environment.");
                return null;
            }

            const config_b64 = Buffer.from(JSON.stringify(config)).toString('base64');
            mcp_server_url = `${url}?api_key=${smithery_api_key}&config=${config_b64}`;
        } else {
            mcp_server_url = url;
        }

        return mcp_server_url;
    } catch (err) {
        console.error(`Issues with form_mcp_server_url:`, err);
        return null;
    }
}

export async function run_mcp_query(query: string, updated_url: string): Promise<string> {
    const client = new MCPClient();
    try {
        console.log(`In run_mcp_query: MCP query: ${query} on ${updated_url}`);

        // Determine transport type based on URL path (before query parameters)
        const parsed_url = new URL(updated_url);
        const transport_type = parsed_url.pathname.endsWith("/sse") ? "sse" : "http";
        console.log(`Using transport type: ${transport_type} for path: ${parsed_url.pathname}`);

        const result = await client.processQuery(query, updated_url, transport_type);
        return result;
    } catch (err) {
        const error_msg = `Error processing MCP query: ${(err as Error).message}`;
        return error_msg;
    } finally {
        // Cleanup is equivalent to Python's __aexit__
        await client.cleanup(); // TODO check if this is fine
    }
}

declare module '@a2a-js/sdk/client' {
    interface A2AClient {
        sendMessageThreaded(message: Message): Promise<void>;
    }
}

// Add the threaded method to the A2AClient class if it doesn't exist
if (!A2AClient.prototype.sendMessageThreaded) { // TODO check
    A2AClient.prototype.sendMessageThreaded = async function (message: Message): Promise<void> {
        /* Send a message in a separate thread without waiting for a response */
        (async () => {
            try {
                for await (const _event of this.sendMessageStream({ message })) {
                // ignore all streamed events
                }
            } catch (err) {
                console.error('sendMessageThreaded error:', err);
            }
        })();
    };
}

// Update handle_message to detect this special format
export async function handle_external_message(
    msg_text: string,
    task_id: string,
    msg: Message
): Promise<Message | null> {
    /* Handle specially formatted external messages */
    try {
        const lines = msg_text.split("\n");

        if (lines[0] !== "__EXTERNAL_MESSAGE__") {
            return null;
        }

        let from_agent: string | null = null;
        let to_agent: string | null = null;
        let message_content = "";
        let in_message = false;

        for (const line of lines.slice(1)) {
            if (line.startsWith("__FROM_AGENT__")) {
                from_agent = line.slice("__FROM_AGENT__".length);
            } else if (line.startsWith("__TO_AGENT__")) {
                to_agent = line.slice("__TO_AGENT__".length);
            } else if (line === "__MESSAGE_START__") {
                in_message = true;
            } else if (line === "__MESSAGE_END__") {
                in_message = false;
            } else if (in_message) {
                message_content += line + "\n";
            }
        }

        message_content = message_content.trimEnd();

        console.log(`Received external message from ${from_agent} to ${to_agent}`);
        const formatted_text = `FROM ${from_agent}: ${message_content}`;
        console.log("Message Text:", message_content);
        console.log("UI MODE:", UI_MODE);

        const agent_id = get_agent_id();

        if (UI_MODE) {
            console.log("Forwarding message to UI client");
            if (from_agent && to_agent) {
                console.log(`Sending to UI client`);
                await send_to_ui_client(formatted_text, from_agent, task_id);

                const message : Message = ({
                    kind: "message",
                    role: "agent",
                    messageId: uuidv4(),
                    parts: [{ kind: "text", text: `Message received by Agent ${agent_id}` }],
                    // parentMessageId: msg.messageId, TODO: check if needed
                    taskId: task_id,
                });

                return message;
                // return new Message({
                //     role: MessageRole.AGENT,
                //     content: new TextContent({ text: `Message received by Agent ${agent_id}` }),
                //     parent_message_id: msg.message_id,
                //     task_id,
                // });
            } else {
                console.warn("from_agent or to_agent is null, skipping send_to_ui_client");
                return null;
            }
        } else {
            try {
                const terminal_client = new A2AClient(LOCAL_TERMINAL_URL);
                const message_user: Message = {
                    kind: "message",
                    role: "user",
                    messageId: uuidv4(),
                    parts: [{ kind: "text", text: formatted_text }],
                    taskId: task_id,
                    metadata: {
                        custom_fields: {
                            is_from_peer: true,
                            is_user_message: true,
                            source_agent: from_agent,
                            forwarded_by_bridge: true,
                        },
                    },
                };
                terminal_client.sendMessageThreaded(message_user);

                const message_agent: Message = {
                    kind: "message",
                    role: "agent",
                    messageId: uuidv4(),
                    parts: [{ kind: "text", text: `Message received by Agent ${agent_id}` }],
                    taskId: task_id,
                    metadata: {
                        custom_fields: {
                            parentMessageId: msg.messageId
                        },
                    },
                };
                return message_agent;
            } catch (e: unknown) {
                console.log("Error forwarding to local terminal:", e);

                const error_msg: Message = {
                    kind: "message",
                    role: "agent",
                    messageId: uuidv4(),
                    parts: [{ kind: "text", text: `Failed to deliver message: ${(e as Error).message}` }],
                    taskId: task_id,
                    metadata: {
                        custom_fields: {
                            parentMessageId: msg.messageId,
                        },
                    },
                };
                return error_msg;
            }
        }
    } catch (e: unknown) {
        console.log("Error parsing external message:", e);
        return null;
    }
}

export const message_improvement_decorators: Record<string, (...args: any[]) => any> = {};

export function message_improver(name?: string) {
    /*Decorator to register message improvement functions*/
    return function (func: (...args: any[]) => any) {
        const decorator_name = name || func.name;
        message_improvement_decorators[decorator_name] = func;
        return func;
    };
}

export function register_message_improver(name: string, improver_func: (...args: any[]) => any) {
    message_improvement_decorators[name] = improver_func;
}

export function get_message_improver(name: string): ((...args: any[]) => any) | undefined {
    return message_improvement_decorators[name];
}

export function list_message_improvers(): string[] {
    return Object.keys(message_improvement_decorators);
}

export async function default_claude_improver(message_text: string): Promise<string> {
    /*Default Claude-based message improvement*/
    if (!IMPROVE_MESSAGES) return message_text;

    try {
        const additional_prompt =
        "Do not respond to the content of the message - it's intended for another agent. You are helping an agent communicate better with other agents.";
        const system_prompt = additional_prompt + " " + IMPROVE_MESSAGE_PROMPTS["default"];
        console.log(system_prompt);

        const improved_message = await call_claude_direct(message_text, system_prompt);
        console.log(`Improved message: ${improved_message}`);

        return improved_message || message_text;
    } catch (e: any) {
        console.error(`Error improving message: ${e}`);
        return message_text;
    }
}

message_improver("default_claude")(default_claude_improver);

class AgentBridge extends A2AExpressApp {
    /*Global Agent Bridge - Can be used for any agent in the network.*/
    active_improver: string;

    constructor(requestHandler?: any) {
        super(requestHandler);           // call base constructor
        this.active_improver = "default_claude"; // add extra field
    }

    set_message_improver(improver_name: string): boolean {
        /*Set the active message improver by name*/
        if (improver_name in message_improvement_decorators) {
            this.active_improver = improver_name;
            console.log(`Message improver set to: ${improver_name}`);
            return true;
        } else {
            console.log(
                `Unknown improver: ${improver_name}. Available: ${list_message_improvers()}`
            );
            return false;
        }
    }

    set_custom_improver(improver_func: (...args: any[]) => any, name: string = "custom"): void {
        /*Set a custom improver function*/
        register_message_improver(name, improver_func);
        this.active_improver = name;
        console.log(`Custom message improver '${name}' registered and activated`);
    }

    improve_message_direct(message_text: string): string {
        /*Improve a message using the active registered improver.*/
        const improver_func = message_improvement_decorators[this.active_improver];
        if (improver_func) {
            try {
                return improver_func(message_text);
            } catch (e: any) {
                console.error(`Error in improver '${this.active_improver}':`, e);
                return message_text; // Fallback to original message on error
            }
        } else {
            console.error(`No improver registered with name '${this.active_improver}'`);
            return message_text; // Fallback to original message if no improver found
        }
    }

    async handle_message(msg: Message): Promise<Message> {
        // Ensure task_id
        const task_id = msg.taskId || uuidv4(); // changed from task_id
        const agent_id = get_agent_id();

        console.log(`Agent '${agent_id}': Received message with ID: '${msg.messageId}'`);
        console.log(`[DEBUG] Message kind: '${msg.parts[0]?.kind}'`);
        console.log(`[DEBUG] Message ID: '${msg.messageId}'`);
        console.log(`Agent '${agent_id}': Message metadata: '${JSON.stringify(msg.metadata)}'`);

        // Handle non-text content
        const textPart = msg.parts.find(p => p.kind === 'text');
        if (!textPart) {
            console.error(`Agent ${agent_id}: Received non-text content. Returning error.`);
            const errorMessage: Message = {
                kind: 'message',
                role: 'agent',
                messageId: uuidv4(),
                taskId: task_id, 
                parts: [{ kind: 'text', text: 'Only text payloads supported.'}],
                metadata: {
                    custom_fields: {
                        parentMessageId: msg.messageId
                    }
                }
            };
            return errorMessage;
        }

        // const user_text = (msg.content as TextContent).text;
        const user_text = textPart.text;
        console.log(`Agent ${agent_id}: Received text: ${user_text.slice(0, 50)}...`);

        // Extract metadata
        let metadata: Record<string, any>;

        if (msg.metadata && "custom_fields" in msg.metadata && msg.metadata.custom_fields) {
            // Handle Metadata object format
            metadata = msg.metadata.custom_fields;
            console.log("Using custom_fields:", metadata);
        } else {
            // Handle dictionary format
            metadata = msg.metadata || {};
            console.log("Using direct metadata:", metadata);
        }

        const path: string = metadata["path"] ?? "";
        const source_agent: string = metadata["source_agent"] ?? "";
        const is_from_peer: boolean = metadata["is_from_peer"] ?? false;
        const is_external: boolean = metadata["is_external"] ?? false;
        const from_agent: string = metadata["from_agent_id"] ?? "unknown";
        const additional_context: string = metadata["additional_context"] ?? "";

        const current_path = path ? `${path}>${agent_id}` : agent_id;
        console.log(`Agent ${agent_id}: Current path: ${current_path}`);


        if (user_text.startsWith("__EXTERNAL_MESSAGE__")) {
            console.log("--- External Message Detected ---");
            const external_response = await handle_external_message(user_text, task_id, msg);
            if (external_response) {
                return external_response;
            }
        }

        if (is_from_peer) {
            // Handle messages from peer agents - already processed by our terminal
            // Just return acknowledgment
            console.log("Received message from peer agent");
            return {
                kind: 'message',
                role: 'agent',
                messageId: uuidv4(),
                taskId: task_id,
                parts: [{ kind: 'text', text: `Message from peer agent received` }],
                metadata: {
                    custom_fields: {
                        parentMessageId: msg.messageId
                    }
                }
            };
        } else {
            log_message(
                task_id,
                current_path,
                `Agent ${agent_id}`,
                user_text
            );
            console.log(`Agent ${agent_id}: Logging message to ${current_path}`);

            // Check if message to another agent
            if (user_text.startsWith("@")) {
                // Parse the recipient
                const parts = user_text.includes(" ")
                    ? [user_text.slice(0, user_text.indexOf(" ")), user_text.slice(user_text.indexOf(" ") + 1)]
                    : [user_text];
                if (parts.length > 1) {
                    const target_agent = parts[0]!.slice(1); // Remove the @ symbol
                    let message_text = parts[1]!;

                    // Improve message if feature is enabled
                    if (IMPROVE_MESSAGES) {
                        message_text = await this.improve_message_direct(message_text);
                        log_message(task_id, current_path, `Claude ${agent_id}`, message_text);
                    }

                    console.log(`Target agent: ${target_agent}`);
                    console.log(`Improved message text: ${message_text}`);

                    // Send to the target agent's bridge
                    const result = await send_to_agent(target_agent, message_text, task_id, {
                        path: current_path,
                        source_agent: agent_id,
                    });

                    // Return result to user
                    return {
                        kind: "message",
                        role: "agent",
                        messageId: uuidv4(),
                        parts: [{ kind: "text", text: `[AGENT ${agent_id}]: ${message_text}` }],
                        taskId: task_id,
                        metadata: {
                            custom_fields: {
                                parentMessageId: msg.messageId,
                                targetAgent: target_agent,
                            },
                        },
                    };
                } else {
                    // Invalid @ command format
                    return {
                        kind: "message",
                        role: "agent",
                        messageId: uuidv4(),
                        parts: [{ kind: "text", text: `[AGENT ${agent_id}] Invalid format. Use '@agent_id message' to send a message.` }],
                        taskId: task_id,
                        metadata: {
                            custom_fields: {
                                parentMessageId: msg.messageId,
                            },
                        },
                    };
                }
            } else if (user_text.startsWith("#")) {
                console.log(`Detected natural language command: ${user_text}`);   
                const parts = user_text.includes(" ")
                    ? [user_text.slice(0, user_text.indexOf(" ")), user_text.slice(user_text.indexOf(" ") + 1)]
                    : [user_text];

                const formatErrorMsg: Message = {
                    kind: "message",
                    role: "agent",
                    messageId: uuidv4(),
                    parts: [{ kind: "text", text: `[AGENT ${agent_id}] Invalid format. Use '#registry_provider:mcp_server_name query' to send a query to an MCP server.`}],
                    taskId: task_id,
                    metadata: {
                        custom_fields: {
                            parentMessageId: msg.messageId,
                        },
                    },
                };

                if (parts.length < 2 || !parts[0]) {
                    return formatErrorMsg;
                }

                if (parts.length > 1 && parts[0].slice(1).split(":").length === 2) {
                    const [requested_registry, mcp_server_to_call] = parts[0].slice(1).split(":");
                    const query = parts[1];
                    if (!requested_registry || !mcp_server_to_call || !query) {
                        console.log(`Invalid command format: ${user_text}`);
                        return formatErrorMsg
                    }

                    console.log(`Requested registry: ${requested_registry}, MCP server to call: ${mcp_server_to_call}, query: ${query}`);

                    const response = await get_mcp_server_url(requested_registry, mcp_server_to_call);
                    console.log("Response from get_mcp_server_url:", response);

                    if (!response) {
                        return {
                            kind: "message",
                            role: "agent",
                            messageId: uuidv4(),
                            parts: [{ kind: "text", text: `[AGENT ${agent_id}] MCP server '${mcp_server_to_call}' not found in registry. Please check the server name and try again.` }],
                            taskId: task_id,
                            metadata: {
                                custom_fields: {
                                    parentMessageId: msg.messageId,
                                },
                            },
                        }
                    }

                    const [mcp_server_url, config_details, registry_name] = response;
                    console.log(`Received details from DB: ${mcp_server_url}, ${config_details}, ${registry_name}`);

                    const mcp_server_final_url = await form_mcp_server_url(mcp_server_url, config_details, registry_name);
                    console.log(`MCP server final URL: ${mcp_server_final_url}`);

                    if (!mcp_server_final_url) {
                        return {
                            kind: "message",
                            role: "agent",
                            messageId: uuidv4(),
                            parts: [{ kind: "text", text: `[AGENT ${agent_id}] Ensure the required API key for registry is in env file.` }],
                            taskId: task_id,
                            metadata: {
                                custom_fields: {
                                    parentMessageId: msg.messageId,
                                },
                            },
                        }
                    }

                    console.log(`Running MCP query: ${query} on ${mcp_server_final_url}`);
                    const result = await run_mcp_query(query, mcp_server_final_url);
                    console.log(`# Result from MCP query: ${result}`);

                    return {
                        kind: "message",
                        role: "agent",
                        messageId: uuidv4(),
                        parts: [{ kind: "text", text: `[AGENT ${agent_id}] MCP query result: ${result}` }],
                        taskId: task_id,
                        metadata: {
                            custom_fields: {
                                parentMessageId: msg.messageId,
                                mcpServer: mcp_server_to_call,
                            },
                        },
                    };
                } else {
                    // Invalid # command format
                    return formatErrorMsg;
                }
            } else if (user_text.startsWith("/")) {
                const parts = user_text.includes(" ")
                    ? [user_text.slice(0, user_text.indexOf(" ")), user_text.slice(user_text.indexOf(" ") + 1)]
                    : [user_text];

                const command = parts.length > 0 && parts[0] ? parts[0].slice(1) : "";

                // Handle special commands
                if (command === "quit") {
                    return {
                        kind: "message",
                        role: "agent",
                        messageId: uuidv4(),
                        parts: [{ kind: "text", text: `[AGENT ${agent_id}] Exiting session...` }],
                        taskId: task_id,
                        metadata: {
                            custom_fields: {
                                parentMessageId: msg.messageId,
                            },
                        },
                    };
                } else if (command === "help") {
                    const help_text = `Available commands:
                        /help - Show this help message
                        /quit - Exit the terminal
                        /query [message] - Get a response from the agent privately
                        @<agent_id> [message] - Send a message to a specific agent`;
                    return {
                        kind: "message",
                        role: "agent",
                        messageId: uuidv4(),
                        parts: [{ kind: "text", text: `[AGENT ${agent_id}] ${help_text}` }],
                        taskId: task_id,
                        metadata: {
                            custom_fields: {
                                parentMessageId: msg.messageId,
                            },
                        },
                    };
                } else if (command === "query") {
                    if (parts.length > 1 && parts[1]) {
                        const query_text = parts[1];
                        console.log(`Processing query command: '${query_text}'`);

                        let claude_response = await call_claude(
                            query_text,
                            additional_context,
                            task_id,
                            current_path,
                            "You are Claude, an AI assistant. Provide a direct, helpful response to the user's question. Treat it as a private request for guidance and respond only to the user."
                        );

                        if (!claude_response) {
                            console.warn("Warning: Claude returned empty response");
                            claude_response = "Sorry, I couldn't process your query. Please try again.";
                        } else {
                            console.log(`Claude response received (${claude_response.length} chars)`);
                            console.log(`Response preview: ${claude_response.slice(0, 50)}...`);
                        }

                        const formatted_response = `[AGENT ${agent_id}] ${claude_response}`;

                        return {
                            kind: "message",
                            role: "agent",
                            messageId: uuidv4(),
                            parts: [{ kind: "text", text: formatted_response }],
                            taskId: task_id,
                            metadata: {
                                custom_fields: {
                                    parentMessageId: msg.messageId,
                                },
                            },
                        };
                    } else {
                        return {
                            kind: "message",
                            role: "agent",
                            messageId: uuidv4(),
                            parts: [{ kind: "text", text: `[AGENT ${agent_id}] Please provide a query after the /query command.` }],
                            taskId: task_id,
                            metadata: {
                                custom_fields: {
                                    parentMessageId: msg.messageId,
                                },
                            },
                        };
                    }
                } else {
                    const help_text = `Unknown command. Available commands:
                        /help - Show this help message
                        /quit - Exit the terminal
                        /query [message] - Get a response from the agent privately
                        @<agent_id> [message] - Send a message to a specific agent`;
                    return {
                        kind: "message",
                        role: "agent",
                        messageId: uuidv4(),
                        parts: [{ kind: "text", text: `[AGENT ${agent_id}] ${help_text}` }],
                        taskId: task_id,
                        metadata: {
                            custom_fields: {
                                parentMessageId: msg.messageId,
                            },
                        },
                    };
                }
            } else {
                // Regular message - process locally 
                const claude_response = await call_claude(
                    user_text,
                    additional_context,
                    task_id,
                    current_path
                );
                const formatted_response = `[AGENT ${agent_id}] ${claude_response}`;

                return {
                    kind: "message",
                    role: "agent",
                    messageId: uuidv4(),
                    parts: [{ kind: "text", text: formatted_response }],
                    taskId: task_id,
                    metadata: {
                        custom_fields: {
                            parentMessageId: msg.messageId,
                        },
                    },
                };
            }
        }
    }
}

const PUBLIC_URL = process.env.PUBLIC_URL;
const API_URL = process.env.API_URL;

// Main entry point
async function main() {
    // Register with the registry if PUBLIC_URL is set
    if (PUBLIC_URL && API_URL) {
        const agent_id = await get_agent_id();
        await register_with_registry(agent_id, PUBLIC_URL, API_URL);
    } else {
        console.warn("WARNING: PUBLIC_URL and/or API_URL environment variable not set. Agent will not be registered.");
    }

    const agent_id = await get_agent_id();
    console.log(`Starting Agent ${agent_id} bridge on port ${PORT}`);
    console.log(`Agent terminal port: ${TERMINAL_PORT}`);
    console.log(`Message improvement feature is ${IMPROVE_MESSAGES ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Logging conversations to ${path.resolve(LOG_DIR)}`);

    // Start server
    const app = express();
    const bridge = new AgentBridge(app);
    // await run_server(bridge, { host: '0.0.0.0', port: PORT });
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Agent bridge listening on port ${PORT}`);
    });
}

// Run main 
main().catch(err => {
    console.error('Error running agent:', err);
    process.exit(1);
});