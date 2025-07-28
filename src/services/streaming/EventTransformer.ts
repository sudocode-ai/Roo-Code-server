import { ClineAsk, ClineMessage, ClineSay, TokenUsage } from "@roo-code/types"
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
	public transformMessageEvent(taskId: string, message: ClineMessage): StreamEvent[] | null {
		try {
			if (message.partial) {
				return null
			}
			const { content, data } = this.messageToGenAIContent(message)
			if ((!content || content.length === 0) && !data) {
				return null
			}
			const streamEvents = content?.map((content) => ({
				type: "message",
				content,
				data,
				task_id: taskId,
				event_id: this.generateEventId(),
				timestamp: Date.now(),
			}))
			if (!streamEvents) {
				return null
			}
			return streamEvents
		} catch (error) {
			console.error("Error transforming message event:", error)
			return [
				{
					type: "error",
					task_id: taskId,
					event_id: this.generateEventId(),
					timestamp: Date.now(),
					data: {
						error: `Error transforming message: ${error instanceof Error ? error.message : "Unknown error"}`,
					},
				},
			]
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
	private messageToGenAIContent(message: ClineMessage): { content?: Content[]; data?: any } {
		switch (message.type) {
			case "say":
				return this.transformSayMessage(message)
			case "ask":
				return this.transformAskMessage(message)
			default:
				return {}
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
	private transformSayMessage(message: ClineMessage): { content?: Content[]; data?: any } {
		const say = message.say as ClineSay

		// TODO: Make sure to handle all say messages.
		switch (say) {
			// Ignore API request messages.
			case "api_req_started":
			case "api_req_finished":
			case "api_req_retried":
			case "api_req_retry_delayed":
			case "api_req_deleted":
			case "shell_integration_warning":
			case "checkpoint_saved":
			case "rooignore_error":
			case "diff_error":
				return {}

			case "reasoning":
				// Agent's internal reasoning/thoughts - map to thought
				if (message.text) {
					return {
						content: [
							{
								role: "model",
								parts: [{ text: message.text, thought: true }],
							},
						],
						data: {
							say: say,
						},
					}
				}
				return {}

			case "text":
				// General text response from agent
				if (message.text) {
					return {
						content: [
							{
								role: "model",
								parts: [{ text: message.text }],
							},
						],
						data: {
							say: say,
						},
					}
				}
				return {}

			case "command_output": {
				// Command execution result - map to functionResponse
				// Use message timestamp as fallback ID for correlation
				const functionCallId = message.ts.toString()
				return {
					content: [
						{
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
						},
					],
					data: {
						say: say,
					},
				}
			}

			case "browser_action": {
				// Browser action initiation - map to functionCall
				return {
					content: [
						{
							role: "model",
							parts: [
								{
									functionCall: {
										// TODO: Verify tool name.
										name: "browser_action",
										args: {
											action: message.text || "Browser action initiated",
											...(message.images &&
												message.images.length > 0 && { images: message.images }),
										},
									},
								},
							],
						},
					],
					data: {
						say: say,
					},
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
					content: [
						{
							role: "user",
							parts: [
								{
									functionResponse: {
										name: "browser_action",
										response: browserResponse,
									},
								},
							],
						},
					],
					data: {
						say: say,
					},
				}
			}
			// TODO: Properly parse the tool name and id from the message.
			case "mcp_server_request_started": {
				// MCP server request initiation - map to functionCall
				const functionCallId = message.ts.toString()
				return {
					content: [
						{
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
						},
					],
					data: {
						say: say,
					},
				}
			}
			case "mcp_server_response": {
				// MCP server response - map to functionResponse
				const functionCallId = message.ts.toString()
				return {
					content: [
						{
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
						},
					],
					data: {
						say: say,
					},
				}
			}
			case "error": {
				// Error message - treat as regular text
				return {
					content: [
						{
							role: "user",
							parts: [{ text: `Error: ${message.text || "Unknown error"}` }],
						},
					],
					data: {
						say: say,
					},
				}
			}
			case "completion_result":
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || `[${say}]` }],
						},
					],
					data: {
						say: say,
					},
				}
			case "user_feedback":
			case "user_feedback_diff":
				// User interaction messages - treat as regular text
				if (message.text) {
					return {
						content: [
							{
								role: "user",
								parts: [{ text: message.text }],
							},
						],
						data: {
							say: say,
						},
					}
				}
				return {}

			case "codebase_search_result": {
				// Search results - map to functionResponse
				const functionCallId = message.ts.toString()
				return {
					content: [
						{
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
						},
					],
					data: {
						say: say,
					},
				}
			}

			case "subtask_result":
				// Subtask completion - map to functionResponse
				return {
					content: [
						{
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
						},
					],
					data: {
						say: say,
					},
				}

			default:
				// Fallback for unhandled say types - treat as regular text
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || `[${say}]` }],
						},
					],
					data: {
						say: say,
					},
				}
		}
	}

	private transformAskMessage(message: ClineMessage): { content?: Content[]; data?: any } {
		const ask = message.ask as ClineAsk

		// TODO: Handle other ask types.
		switch (ask) {
			case "tool": {
				try {
					if (message.text) {
						const toolData = JSON.parse(message.text)
						const toolName = toolData.tool
						// TODO: Have handlers for each tool type (considering nested structures like batchFiles, etc).

						if (toolData.content !== undefined) {
							const { tool, content, ...otherArgs } = toolData
							return {
								content: [
									{
										role: "model",
										parts: [
											{
												functionCall: {
													name: toolName,
													args: otherArgs,
													id: message.ts.toString(),
												},
											},
										],
									},
									{
										role: "user",
										parts: [
											{
												functionResponse: {
													name: toolName,
													response: {
														content: content,
													},
													id: message.ts.toString(),
												},
											},
										],
									},
								],
								data: {
									ask: ask,
								},
							}
						} else {
							const { tool, ...args } = toolData

							return {
								content: [
									{
										role: "model",
										parts: [
											{
												functionCall: {
													name: toolName,
													args: args,
													id: message.ts.toString(),
												},
											},
										],
									},
								],
								data: {
									ask: ask,
								},
							}
						}
					}
				} catch (error) {
					console.error("Error parsing tool message:", error)
					return {
						content: [
							{
								role: "model",
								parts: [{ text: message.text || `[${ask}]` }],
							},
						],
					}
				}
				return {
					content: [
						{
							role: "model",
							parts: [{ text: `[${ask}]` }],
						},
					],
					data: {
						ask: ask,
					},
				}
			}

			// User-facing questions that require interaction
			case "followup":
				// Follow-up questions from the agent to clarify requirements
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Follow-up question from agent" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			case "command":
				// Permission requests to execute commands
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Permission request to execute command" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			case "resume_task":
				// Requests to resume a paused/stopped task
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Resume task request" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			case "resume_completed_task":
				// Requests to resume a completed task
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Resume completed task request" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			case "browser_action_launch":
				// Permission to launch browser for actions
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Browser action launch request" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			case "use_mcp_server":
				// Permission to use MCP server
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "MCP server usage request" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			// Status notifications and results
			case "completion_result":
				// Task completion notifications
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Task completion result" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			case "command_output":
				// Command execution output/results
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Command execution output" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			// Error states that require user intervention
			case "api_req_failed":
				// API request failures
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "API request failed - user intervention needed" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			case "mistake_limit_reached":
				// When the agent has made too many mistakes
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Mistake limit reached - user guidance needed" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			case "auto_approval_max_req_reached":
				// When auto-approval limit is reached
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || "Auto-approval limit reached - manual approval required" }],
						},
					],
					data: {
						ask: ask,
					},
				}

			default:
				// Fallback for any unhandled ask types - still provide content
				return {
					content: [
						{
							role: "model",
							parts: [{ text: message.text || `[${ask}]` }],
						},
					],
					data: {
						ask: ask,
						message: message.text,
					},
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
