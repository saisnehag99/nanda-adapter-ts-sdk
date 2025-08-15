import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Anthropic } from "@anthropic-ai/sdk";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"; 
import { Tool, MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";

export type jsonrpc_response = {
    result?: {
        artifacts?: {
        parts?: { text?: string }[];
        }[];
    };
};

export function parse_jsonrpc_response(response: string | object): string {
    /*Helper function to parse JSON-RPC responses from MCP server*/
    let response_obj: any = response;

    // If response is a string, try to parse it as JSON
    if (typeof response === "string") {
        try {
            response_obj = JSON.parse(response);
        } catch {
            return response;
        }
    }

    // Ensure it's an object with the expected JSON-RPC structure
    if (
        typeof response_obj === "object" &&
        response_obj !== null &&
        "result" in response_obj
    ) {
        const artifacts = response_obj.result?.artifacts;
        if (Array.isArray(artifacts) && artifacts.length > 0) {
            const parts = artifacts[0]?.parts;
            if (Array.isArray(parts) && parts.length > 0) {
                return parts[0]?.text ?? String(response);
            }
        }
    }

    // Fallback: return original response as string
    return typeof response === "string" ? response : JSON.stringify(response);
}

export function parse_jsonrpc_response_task_id(response: string | object): string {
    /*Helper function to parse JSON-RPC responses from MCP server*/
    let response_obj: any = response;

    // If response is a string, try to parse it as JSON
    if (typeof response === "string") {
        try {
            response_obj = JSON.parse(response);
        } catch {
            return response;
        }
    }

    // Ensure it's an object with the expected JSON-RPC structure
    if (
        typeof response_obj === "object" &&
        response_obj !== null &&
        "result" in response_obj
    ) {
        return response_obj.result?.taskId || String(response);
    }

    // Fallback: return original response as string
    return typeof response === "string" ? response : JSON.stringify(response);
}

export class MCPClient {
    private mcp: Client;
    private anthropic: Anthropic;
    private tools: Tool[] = [];

    constructor() {
        // this.session = null;
        const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "your-key";
        this.anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
        this.mcp = new Client({ name: "mcp-client", version: "1.0.0" });
    }

    async cleanup() {
        /*Clean up resources*/
        await this.mcp.close();
    }
    
    public async connect_to_mcp_and_get_tools(
        mcpServerUrl: string,
        transportType: "http" | "sse" = "http"
    ): Promise<void> {
        /* Connect to MCP server and return available tools
        
        Args:
            mcp_server_url: URL of the MCP server
            transport_type: Either 'http' or 'sse' for transport protocol */
        try {
            function createTransport(mcpServerUrl: string, transportType: string): Transport {
                const url = new URL(mcpServerUrl);
                if (transportType === "sse") {
                    return new SSEClientTransport(url);
                } else {
                    return new StreamableHTTPClientTransport(url);
                }
            }

            const transport = createTransport(mcpServerUrl, transportType);
            await this.mcp.connect(transport);

            transport.onclose = async () => {
                console.log("SSE transport closed.");
                await this.cleanup();
            };

            transport.onerror = async (error) => {
                console.log("SSE transport error: ", error);
                await this.cleanup();
            };

            // List tools
            const toolsResult = await this.mcp.listTools();
            this.tools = toolsResult.tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
            }));

            console.log(
                "Connected to server with tools:",
                this.tools.map(({ name }) => name)
            );
        } catch (e: any) {
            console.error(`Error connecting to MCP server: ${e.message ?? e}`);
        }
    }

    public async get_tools(): Promise<Tool[]> {
        return this.tools;
    }

    public async get_anthropic_client(): Promise<Anthropic> {
        /* Get the Anthropic client instance */
        return this.anthropic;
    }

    public async get_mcp_client(): Promise<Client> {
        /* Get the MCP client instance */
        return this.mcp;
    }

    public async processQuery(
        query: string,
        mcpServerUrl: string,
        transportType: "http" | "sse" = "http"
    ): Promise<string> {
        try {
            console.log(
                `In MCPClient processQuery: ${query} on ${mcpServerUrl} using ${transportType}`
            );

            // Connect to MCP and get tools
            if (!this.tools || this.tools.length === 0) {
                return "Failed to connect to MCP server";
            }

            // Initialize message history
            const messages: MessageParam[] = [
                { role: "user", content: query },
            ];

            // Call Claude API
            let message = await this.anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 1024,
                messages,
                tools: this.tools,
            });

            // Keep processing until we get a final response without tool calls
            while (true) {
                let hasToolCalls = false;

                // Process each block in the response
                for (const block of message.content) {
                    console.log(block);
                    console.log(block.type);

                    if (block.type === "tool_use") {
                        hasToolCalls = true;
                        const toolName = block.name;
                        const toolArgs = block.input;

                        // Call the tool via MCP session
                        const result = await this.mcp.callTool({
                            name: toolName, 
                            args: toolArgs
                        });
                        console.log("Raw tool result:", result);

                        const processedResult = parse_jsonrpc_response(result);
                        console.log(
                            "Processed tool result:",
                            String(processedResult).slice(0, 100)
                        );

                        // Add assistant's message with tool use
                        messages.push({
                            role: "assistant",
                            content: [
                            {
                                type: "tool_use",
                                id: block.id,
                                name: toolName,
                                input: toolArgs,
                            },
                            ],
                        });

                        // Add the tool result as a user message
                        messages.push({
                            role: "user",
                            content: [
                            {
                                type: "tool_result",
                                tool_use_id: block.id,
                                content: String(processedResult),
                            },
                            ],
                        });
                    }
                }

                if (!hasToolCalls) break;

                console.log("Getting next response from Claude...");

                // Request next response from Claude
                message = await this.anthropic.messages.create({
                    model: "claude-3-5-sonnet-20241022",
                    max_tokens: 1024,
                    messages,
                    tools: this.tools,
                });
            }

            // Assemble final response
            let finalResponse = "";
            for (const block of message.content) {
                if (block.type === "text") {
                    finalResponse += block.text + "\n";
                }
            }

            return finalResponse
            ? parse_jsonrpc_response(finalResponse.trim())
            : "No response generated";
        } catch (e: any) {
            console.error(`Error processing query: ${e.message ?? e}`);
            return `Error: ${e.message ?? String(e)}`;
        }
    }
    
}
