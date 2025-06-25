import { ClineMessage, ClineSay, TokenUsage } from "@roo-code/types"
import { RooCodeEventName } from "@roo-code/types"
import type { Content } from "@google/genai"

export type TUsageMetadata = {
	prompt_token_count: number
	candidates_token_count: number
	total_token_count: number
	// TODO: Add other fields as necessary.
}

export type StreamEvent = {
	event_id: string
	timestamp: number
	task_id?: string
	content?: Content
	type?: string
	data?: any
	usage_metadata?: TUsageMetadata
}

/**
 * EventTransformer service for converting Roo-Code events to Google GenAI Content format.
 */
export class EventTransformer {
	/**
	 * Transform a ClineMessage into a StreamEvent with Google GenAI Content format
	 *
	 * @param taskId - Unique identifier for the task
	 * @param message - The Roo-Code message to transform
	 * @returns StreamEvent with the transformed message content
	 */
	public transformMessageEvent(taskId: string, message: ClineMessage): StreamEvent | null {
		try {
			const content = this.messageToGenAIContent(message)
			if (!content || !content.parts || content.parts.length === 0) {
				return null
			}
			return {
				type: "message",
				content,
				task_id: taskId,
				event_id: this.generateEventId(),
				timestamp: Date.now(),
			}
		} catch (error) {
			console.error("Error transforming message event:", error)
			return {
				type: "error",
				task_id: taskId,
				event_id: this.generateEventId(),
				timestamp: Date.now(),
				data: {
					error: `Error transforming message: ${error instanceof Error ? error.message : "Unknown error"}`,
				},
			}
		}
	}

	/**
	 * Transform a Roo-Code task event into Google GenAI Content format
	 *
	 * @param eventName - The type of task event
	 * @param args - Event-specific arguments
	 * @returns Google GenAI Content representing the task state change
	 */
	public transformTaskEvent(eventName: RooCodeEventName, ...args: any[]): StreamEvent {
		try {
			const taskId = (args[0] as string) || "unknown"

			switch (eventName) {
				case RooCodeEventName.TaskCreated:
				case RooCodeEventName.TaskStarted:
				case RooCodeEventName.TaskCompleted:
				case RooCodeEventName.TaskPaused:
				case RooCodeEventName.TaskUnpaused:
				case RooCodeEventName.TaskAborted:
				case RooCodeEventName.TaskModeSwitched:
					return {
						type: eventName,
						task_id: taskId,
						event_id: this.generateEventId(),
						timestamp: Date.now(),
					}

				case RooCodeEventName.TaskTokenUsageUpdated: {
					const tokenUsage = args[1] as TokenUsage
					return {
						type: eventName,
						task_id: taskId,
						event_id: this.generateEventId(),
						timestamp: Date.now(),
						data: {
							tokenUsage,
						},
					}
				}
				case RooCodeEventName.TaskToolFailed:
					return {
						type: eventName,
						task_id: taskId,
						event_id: this.generateEventId(),
						timestamp: Date.now(),
						data: {
							tool_name: args[1],
							error: args[2],
						},
					}

				default:
					return {
						type: eventName,
						task_id: taskId,
						event_id: this.generateEventId(),
						timestamp: Date.now(),
					}
			}
		} catch (error) {
			console.error("Error transforming task event:", error)
			return {
				event_id: this.generateEventId(),
				timestamp: Date.now(),
				data: {
					error: `Error transforming task event ${eventName}: ${error instanceof Error ? error.message : "Unknown error"}`,
				},
				type: "error",
			}
		}
	}

	/**
	 * Convert a ClineMessage to Google GenAI Content format
	 * @private
	 */
	private messageToGenAIContent(message: ClineMessage): Content | null {
		switch (message.type) {
			case "say":
				return this.transformSayMessage(message)
			// TODO: Ideally there are no ask messages in full auto mode.
			case "ask":
				return null
			default:
				return null
		}
	}

	/**
	 * Transform a 'say' type message to Google GenAI Content
	 *
	 * Function Call Flow:
	 * 1. Function initiation messages (functionCall):
	 *    - mcp_server_request_started: MCP tool started
	 *    - browser_action: Browser action initiated
	 * 2. Function result messages (functionResponse):
	 *    - mcp_server_response: MCP tool results
	 *    - browser_action_result: Browser action results
	 *    - codebase_search_result: Search results
	 *    - command_output: Command execution results
	 * # TODO: Represent tool calls.
	 * @private
	 */
	private transformSayMessage(message: ClineMessage): Content | null {
		const say = message.say as ClineSay

		switch (say) {
			case "reasoning":
				// Agent's internal reasoning/thoughts - map to thought
				if (message.text) {
					return {
						role: "model",
						parts: [{ text: message.text, thought: true }],
					}
				}
				return null

			case "text":
				// General text response from agent
				if (message.text) {
					return {
						role: "model",
						parts: [{ text: message.text }],
					}
				}
				return null

			// Ignore API request messages.
			case "api_req_started":
			case "api_req_finished":
				return null

			case "command_output": {
				// Command execution result - map to functionResponse
				// Use message timestamp as fallback ID for correlation
				const functionCallId = message.ts.toString()
				return {
					role: "user",
					parts: [
						{
							functionResponse: {
								// TODO: Verify tool name.
								name: "execute_command",
								response: {
									output: message.text,
								},
								id: functionCallId,
							},
						},
					],
				}
			}

			case "browser_action": {
				// Browser action initiation - map to functionCall
				const functionCallId = message.ts.toString()
				return {
					role: "model",
					parts: [
						{
							functionCall: {
								// TODO: Verify tool name.
								name: "browser_action",
								args: {
									action: message.text || "Browser action initiated",
									...(message.images && message.images.length > 0 && { images: message.images }),
								},
								id: functionCallId,
							},
						},
					],
				}
			}
			case "browser_action_result": {
				// Browser action result - map to functionResponse
				// TODO: Extract executionId from the message.
				// const functionCallId = message.ts.toString()
				const browserResponse: Record<string, unknown> = {
					result: message.text || "",
				}
				if (message.images && message.images.length > 0) {
					browserResponse.screenshots = message.images
				}
				return {
					role: "user",
					parts: [
						{
							functionResponse: {
								name: "browser_action",
								response: browserResponse,
								// id: functionCallId,
							},
						},
					],
				}
			}
			case "mcp_server_request_started": {
				// MCP server request initiation - map to functionCall
				const functionCallId = message.ts.toString()
				return {
					role: "model",
					parts: [
						{
							functionCall: {
								name: "mcp_tool",
								args: {
									status: "started",
									details: message.text || "MCP server request initiated",
								},
								id: functionCallId,
							},
						},
					],
				}
			}
			case "mcp_server_response": {
				// MCP server response - map to functionResponse
				const functionCallId = message.ts.toString()
				return {
					role: "user",
					parts: [
						{
							functionResponse: {
								// TODO: Extract tool name, id, and response.
								name: "mcp_tool",
								response: { result: message.text || "" },
								id: functionCallId,
							},
						},
					],
				}
			}
			case "error": {
				// Error message - treat as regular text
				return {
					role: "user",
					parts: [{ text: `Error: ${message.text || "Unknown error"}` }],
				}
			}
			case "completion_result":
			case "user_feedback":
			case "user_feedback_diff":
				// User interaction messages - treat as regular text
				if (message.text) {
					return {
						role: "user",
						parts: [{ text: message.text }],
					}
				}
				return {
					role: "user",
				}

			case "codebase_search_result": {
				// Search results - map to functionResponse
				const functionCallId = message.ts.toString()
				return {
					role: "user",
					parts: [
						{
							functionResponse: {
								// TODO: Extract tool name, id, and response.
								name: "search_codebase",
								response: {
									result: message.text || "",
									reasoning: message.reasoning || null,
								},
								id: functionCallId,
							},
						},
					],
				}
			}

			case "subtask_result":
				// Subtask completion - map to functionResponse
				return {
					role: "user",
					parts: [
						{
							functionResponse: {
								// TODO: Extract tool id and response.
								name: "complete_subtask",
								response: { result: message.text || "" },
							},
						},
					],
				}

			default:
				// Fallback for unhandled say types - treat as regular text
				return {
					role: "model",
					parts: [{ text: message.text || `[${say}]` }],
				}
		}
	}

	/**
	 * Generate unique event ID
	 */
	private generateEventId(): string {
		return `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
	}
}
