import express, { Request, Response, NextFunction } from "express"
import { createServer, Server as HttpServer } from "http"
import { WebSocketServer, WebSocket } from "ws"
import { EventEmitter } from "events"
import { createServer as createNetServer } from "net"
import { StreamEvent } from "./EventTransformer"

/**
 * Configuration options for the Streaming Server
 */
export interface StreamingServerConfig {
	enabled: boolean
	port: number
	portRange?: { min: number; max: number }
	logging: boolean
	loggingLevel: "error" | "warn" | "info" | "debug"
	connectionTimeout: number
	heartbeatInterval: number
}

/**
 * Default configuration for the Streaming Server
 */
const DEFAULT_CONFIG: StreamingServerConfig = {
	enabled: true,
	port: 3001,
	portRange: { min: 3001, max: 3100 },
	logging: false,
	loggingLevel: "info",
	connectionTimeout: 60000,
	heartbeatInterval: 30000,
}

export type StreamClientConnection = {
	id: string
	connectedAt: Date
	websocket?: WebSocket
}

/**
 * WebSocket message types for task commands
 */
export interface WebSocketTaskCommand {
	type: "taskCommand"
	commandName: "StartNewTask" | "CancelTask"
	data: any
}

/**
 * Callback for handling task commands from WebSocket clients
 */
export type TaskCommandHandler = (commandName: string, data: any) => Promise<void>

/**
 * Streaming Server for handling WebSocket connections
 * Provides real-time streaming of agent events in google genai format
 */
export class StreamingServer extends EventEmitter {
	private app: express.Application
	private server: HttpServer
	private wss: WebSocketServer
	private config: StreamingServerConfig
	private connections: Map<string, StreamClientConnection> = new Map()
	private heartbeatInterval?: NodeJS.Timeout
	private taskCommandHandler?: TaskCommandHandler

	constructor(config: Partial<StreamingServerConfig> = {}) {
		super()
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.app = express()
		this.server = createServer(this.app)
		this.wss = new WebSocketServer({ server: this.server })

		this.setupWebSocket()
		this.setupHeartbeat()
	}

	/**
	 * Set the task command handler callback
	 */
	public setTaskCommandHandler(handler: TaskCommandHandler): void {
		this.taskCommandHandler = handler
	}

	/**
	 * Setup WebSocket server
	 */
	private setupWebSocket(): void {
		// @ts-ignore
		this.wss.on("connection", (ws: WebSocket, req) => {
			const connectionId = this.generateConnectionId()
			const connection: StreamClientConnection = {
				id: connectionId,
				connectedAt: new Date(),
				websocket: ws,
			}

			this.connections.set(connectionId, connection)
			console.log(`[Streaming Server] WebSocket client connected: ${connectionId}`)

			// Handle WebSocket messages
			// @ts-ignore
			ws.on("message", (data) => {
				try {
					const message = JSON.parse(data.toString())
					this.handleClientMessage(connectionId, message)
				} catch (error) {
					console.error(`[Streaming Server] Invalid message from ${connectionId}:`, error)
				}
			})

			// Handle WebSocket close
			ws.on("close", () => {
				this.connections.delete(connectionId)
				console.log(`[Streaming Server] WebSocket client disconnected: ${connectionId}`)
			})

			// Handle WebSocket errors
			// @ts-ignore
			ws.on("error", (error) => {
				console.error(`[Streaming Server] WebSocket error for ${connectionId}:`, error)
				this.connections.delete(connectionId)
			})
		})
	}

	/**
	 * Setup heartbeat/keepalive functionality
	 */
	private setupHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			const heartbeatEvent: StreamEvent = {
				event_id: this.generateEventId(),
				type: "heartbeat",
				timestamp: Date.now(),
				data: { timestamp: Date.now() },
			}

			this.broadcastEvent(heartbeatEvent)
		}, this.config.heartbeatInterval)
	}

	/**
	 * Handle incoming client messages
	 */
	private handleClientMessage(connectionId: string, message: any): void {
		console.log(`[Streaming Server] Message from ${connectionId}:`, message)

		switch (message.type) {
			case "taskCommand":
				this.handleTaskCommand(connectionId, message as WebSocketTaskCommand)
				break
			default:
				console.log(`[Streaming Server] Unknown message type: ${message.type}`)
		}
	}

	/**
	 * Handle task commands from WebSocket clients
	 */
	private async handleTaskCommand(connectionId: string, message: WebSocketTaskCommand): Promise<void> {
		if (!this.taskCommandHandler) {
			console.error(
				`[Streaming Server] Task command handler not set, cannot process command: ${message.commandName}`,
			)
			this.sendErrorToClient(connectionId, "Task command handler not available")
			return
		}

		try {
			console.log(`[Streaming Server] Processing task command from ${connectionId}: ${message.commandName}`)
			await this.taskCommandHandler(message.commandName, message.data)

			// Send acknowledgment back to client
			this.sendAckToClient(connectionId, message.commandName)
		} catch (error) {
			console.error(`[Streaming Server] Error processing task command ${message.commandName}:`, error)
			this.sendErrorToClient(
				connectionId,
				`Failed to process command: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Send acknowledgment to a specific client
	 */
	private sendAckToClient(connectionId: string, commandName: string): void {
		const connection = this.connections.get(connectionId)
		if (connection?.websocket) {
			const ackMessage = {
				type: "taskCommandAck",
				commandName,
				timestamp: Date.now(),
			}
			this.sendToWebSocketClient(connection.websocket, ackMessage as any)
		}
	}

	/**
	 * Send error message to a specific client
	 */
	private sendErrorToClient(connectionId: string, error: string): void {
		const connection = this.connections.get(connectionId)
		if (connection?.websocket) {
			const errorMessage = {
				type: "error",
				message: error,
				timestamp: Date.now(),
			}
			this.sendToWebSocketClient(connection.websocket, errorMessage as any)
		}
	}

	/**
	 * Broadcast an event to all connected clients
	 */
	public broadcastEvent(event: StreamEvent): void {
		for (const [connectionId, connection] of Array.from(this.connections.entries())) {
			try {
				if (connection.websocket) {
					this.sendToWebSocketClient(connection.websocket, event)
				}
			} catch (error) {
				console.error(`[Streaming Server] Failed to send event to ${connectionId}:`, error)
				this.connections.delete(connectionId)
			}
		}

		this.emit("eventBroadcast", event)
	}

	/**
	 * Send event to WebSocket client
	 */
	private sendToWebSocketClient(ws: WebSocket, event: StreamEvent): void {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(event))
		}
	}

	/**
	 * Generate unique connection ID
	 */
	private generateConnectionId(): string {
		return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
	}

	/**
	 * Generate unique event ID
	 */
	private generateEventId(): string {
		return `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
	}

	/**
	 * Start the streaming server
	 */
	public async start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const { port, portRange } = this.config

			const tryPort = (portToTry: number) => {
				const server = this.server

				const onListening = () => {
					// Update config with the actually used port
					this.config.port = portToTry
					console.log(`[Streaming Server] Server started on port ${portToTry}`)
					console.log(`[Streaming Server] WebSocket endpoint: ws://localhost:${portToTry}`)
					console.log(`[Streaming Server] Status endpoint: http://localhost:${portToTry}/api/status`)
					this.emit("started")
					server.removeListener("error", onError)
					resolve()
				}

				const onError = (error: any) => {
					server.removeListener("listening", onListening)
					if (error.code === "EADDRINUSE") {
						// Port is in use, try next port in range
						if (portRange && portToTry < portRange.max) {
							const nextPort = portToTry + 1
							console.log(`[Streaming Server] Port ${portToTry} not available, trying port ${nextPort}`)
							tryPort(nextPort)
						} else {
							reject(new Error(`No available ports found. Last attempted: ${portToTry}`))
						}
					} else {
						reject(error)
					}
				}

				server.once("listening", onListening)
				server.once("error", onError)
				server.listen(portToTry)
			}

			tryPort(port)
		})
	}

	/**
	 * Stop the Streaming server
	 */
	public async stop(): Promise<void> {
		return new Promise((resolve) => {
			// Clear heartbeat interval
			if (this.heartbeatInterval) {
				clearInterval(this.heartbeatInterval)
			}

			// Close all WebSocket connections
			for (const [connectionId, connection] of Array.from(this.connections.entries())) {
				if (connection.websocket) {
					connection.websocket.close()
				}
			}
			this.connections.clear()

			// Close WebSocket server
			this.wss.close(() => {
				// Close HTTP server
				this.server.close(() => {
					console.log("[Streaming Server] Server stopped")
					this.emit("stopped")
					resolve()
				})
			})
		})
	}

	/**
	 * Get connected clients
	 */
	public getConnections(): StreamClientConnection[] {
		return Array.from(this.connections.values()).map((conn) => ({
			id: conn.id,
			connectedAt: conn.connectedAt,
		}))
	}

	/**
	 * Update server configuration
	 */
	public updateConfig(newConfig: Partial<StreamingServerConfig>): void {
		this.config = { ...this.config, ...newConfig }
		console.log("[Streaming Server] Configuration updated:", newConfig)
	}
}
