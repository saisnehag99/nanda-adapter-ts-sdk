import process from "process"; 
import { spawn, exec } from "child_process";
import { setTimeout, setInterval, clearTimeout, clearInterval } from "timers";
import * as fs from "fs";
import * as os from "os";
import { v4 as uuidv4 } from 'uuid';
import * as path from "path";
import { EventEmitter } from "events";
import { Worker } from "worker_threads";
import * as https from "https";
import * as http from "http";
import fetch from "node-fetch";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import express, { Express, Request, Response } from "express";
import cors from "cors";
import { DateTime } from "luxon";
import PQueue from "p-queue";
import { EventEmitter as EventSignal } from "events";
import { A2AClient } from "@a2a-js/sdk/client";
import { Message, TextPart, SendMessageSuccessResponse } from "@a2a-js/sdk";
import { parse_jsonrpc_response, parse_jsonrpc_response_task_id } from "./mcp_utils.ts";

// Global variables
let bridge_process: any = null;
let registry_url: string | null = null;
let agent_id: string | null = null;
let agent_port: number | null = null;

// Initialize Express app
const app: Express = express();

// Enable CORS with support for credentials
app.use('/api',
    cors({
        origin: '*', // allow all origins
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Accept'],
        credentials: true,
    })
);

// Message queues for SSE (Server-Sent Events)
interface ClientQueue {
  queue: Message[];       // Array storing messages
  event: EventEmitter;   // EventEmitter to signal new messages
}

const client_queues: Record<string, ClientQueue> = {}; // TODO check type

function cleanup(signum?: NodeJS.Signals, frame?: NodeJS.Signals) {
    // Clean up processes on exit
    console.log("Cleaning up processes...");
    if (bridge_process) {
        bridge_process.kill();
        bridge_process = null;
    }
    process.exit(0);
}

function get_registry_url(): string {
    /*Get the registry URL from file or use default*/
    if (registry_url) {
        return registry_url;
    }

    try {
        const filePath = path.resolve('registry_url.txt');
        if (fs.existsSync(filePath)) {
            const url = fs.readFileSync(filePath, 'utf-8').trim();
            console.log(`Using registry URL from file: ${url}`);
            registry_url = url; // cache for future calls TODO?
            return url;
        }
    } catch (error) {
        console.error("Error reading registry URL from file:", error);
    }

    const defaultUrl = 'https://chat.nanda-registry.com:6900';
    console.log(`Registry URL file not found. Using default: ${defaultUrl}`);
    registry_url = defaultUrl; // cache for future calls
    return defaultUrl;
}

async function register_agent(agent_id: string, public_url: number): Promise<boolean> {
    /*Register the agent with the registry*/
    const registry_url = get_registry_url();

    try {
        console.log(`Registering agent ${agent_id} at ${public_url}`);
        const response = await fetch(`${registry_url}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                agent_id: agent_id,
                agent_url: public_url
            }),
        });

        if (response.ok) {
            console.log(`Agent ${agent_id} registered successfully`);
            return true;
        } else {
            const text = await response.text();
            console.error(`Failed to register agent: ${text}`);
            return false;
        }
    } catch (e) {
        console.error(`Error registering agent: ${e}`);
        return false;
    }
}

async function lookup_agent(agent_id: string): Promise<string | null> {
    /*Lookup the agent URL in the registry*/
    const reg_url = get_registry_url();

    try {
        console.log(`Looking up agent ${agent_id} in registry...`);

        const response = await fetch(`${reg_url}/lookup/${agent_id}`, {
            method: 'GET',
        });

        if (response.ok) {
            const data = await response.json();
            let agent_url: string | null = null;
            if (data && typeof data === 'object' && 'agent_url' in data) {
                agent_url = (data as any).agent_url;
            }
            console.log(`Found agent ${agent_id} at URL: ${agent_url}`);
            return agent_url ?? null;
        }

        console.log(`Agent ${agent_id} not found in registry`);
        return null;
    } catch (e) {
        console.error(`Error looking up agent ${agent_id}: ${e}`);
        return null;
    }
}

function add_message_to_queue(client_id: string, message: Message): void {
    /*Add a message to the SSE queue for the client*/
    const client = client_queues[client_id];
    if (client) {
        client.queue.push(message);
        client.event.emit('newMessage'); // TODO check if smae
    }
}

// // Example listener (like a SSE handler) TODO needed?
// function listenForClientMessages(clientId: string) {
//   const client = clientQueues[clientId];
//   if (!client) return;

//   client.event.on('newMessage', () => {
//     while (client.queue.length > 0) {
//       const msg = client.queue.shift();
//       console.log(`Sending message to ${clientId}: ${msg}`);
//     }
//   });
// }

// Message handling endpoints 
app.get('/api/health', (req: Request, res: Response) => {
    /*Health check endpoint*/
    res.json({ status: 'ok', agent_id: agent_id });
});

app.options('/api/send', (req: Request, res: Response) => {
    // Handle preflight OPTIONS request for CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '3600');
    res.sendStatus(204); // No Content
});

app.post('/api/send', async (req: Request, res: Response) => {
    try {
        const data = req.body;
        if (!data || !data.message) {
            return res.status(400).json({ error: 'Missing message in request' });
        }

        const message_text: string = data.message;
        const task_id: string | undefined = data.task_id;
        const client_id: string = data.client_id ?? 'ui_client';

        const metadata = {
            source: 'ui_client',
            client_id: client_id,
        };

        if (!agent_port) throw new Error('Agent port not set');

        const bridge_url = `http://localhost:${agent_port}/a2a`; // base URL for bridge
        const client = new A2AClient(bridge_url);

        const message: Message = {
            kind: "message",
            role: "user",
            messageId: uuidv4(),
            parts: [{ kind: "text", text: message_text }],
            taskId: task_id,
            metadata: {
                custom_fields: metadata,
            }
        }
        const response_message = await client.sendMessage({ message: message });

        if (!response_message) {
            return res.status(500).json({ error: 'No response from agent' });
        }

        console.log('Response:', response_message);

        const response_text = parse_jsonrpc_response(response_message);

        if (!response_text) {
            return res.status(500).json({ error: 'Received non-text response' });
        }

        const response_task_id = parse_jsonrpc_response_task_id(response_message);

        if (!response_task_id) {
            return res.status(500).json({ error: 'No task ID in response' });
        }

        return res.json({
            response: response_text,
            task_id: response_task_id,
            agent_id,
        });
    } catch (e) {
        console.error('Error in /api/send:', (e as Error).message);
        return res.status(500).json({ error: (e as Error).message });
    }
});
