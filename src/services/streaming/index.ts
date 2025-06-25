/**
 * Streaming Server module - Provides WebSocket and HTTP/SSE streaming for agent events
 *
 * This module exports the streaming server implementation for handling real-time
 * streaming of agent events to external clients in google genai format.
 */

export { StreamingServer } from "./StreamingServer"
export { EventTransformer } from "./EventTransformer.js"

export type { StreamingServerConfig, WebSocketTaskCommand } from "./StreamingServer"
export type { StreamEvent } from "./EventTransformer"
