import { EventEmitter } from "events"
import * as vscode from "vscode"
import fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"

import {
	RooCodeAPI,
	RooCodeSettings,
	RooCodeEvents,
	RooCodeEventName,
	ProviderSettings,
	ProviderSettingsEntry,
	isSecretStateKey,
	IpcOrigin,
	IpcMessageType,
	TaskCommandName,
	TaskEvent,
} from "@roo-code/types"
import { IpcServer } from "@roo-code/ipc"
import { StreamingServer, StreamingServerConfig, EventTransformer } from "../services/streaming"

import { Package } from "../shared/package"
import { getWorkspacePath } from "../utils/path"
import { ClineProvider } from "../core/webview/ClineProvider"
import { openClineInNewTab } from "../activate/registerCommands"

export class API extends EventEmitter<RooCodeEvents> implements RooCodeAPI {
	private readonly outputChannel: vscode.OutputChannel
	private readonly sidebarProvider: ClineProvider
	private readonly context: vscode.ExtensionContext
	private readonly ipc?: IpcServer
	private readonly taskMap = new Map<string, ClineProvider>()
	private readonly log: (...args: unknown[]) => void
	private logfile?: string

	// streaming server integration
	private streamingServer?: StreamingServer
	private eventTransformer?: EventTransformer

	constructor(
		outputChannel: vscode.OutputChannel,
		provider: ClineProvider,
		socketPath?: string,
		enableLogging = false,
	) {
		super()

		this.outputChannel = outputChannel
		this.sidebarProvider = provider
		this.context = provider.context

		if (enableLogging) {
			this.log = (...args: unknown[]) => {
				this.outputChannelLog(...args)
				console.log(args)
			}

			this.logfile = path.join(os.tmpdir(), "roo-code-messages.log")
		} else {
			this.log = () => {}
		}

		this.registerListeners(this.sidebarProvider)

		if (socketPath) {
			const ipc = (this.ipc = new IpcServer(socketPath, this.log))

			ipc.listen()
			this.log(`[API] ipc server started: socketPath=${socketPath}, pid=${process.pid}, ppid=${process.ppid}`)

			ipc.on(IpcMessageType.TaskCommand, async (_clientId, { commandName, data }) => {
				switch (commandName) {
					case TaskCommandName.StartNewTask:
						this.log(`[API] StartNewTask -> ${data.text}, ${JSON.stringify(data.configuration)}`)
						await this.startNewTask(data)
						break
					case TaskCommandName.CancelTask:
						this.log(`[API] CancelTask -> ${data}`)
						await this.cancelTask(data)
						break
					case TaskCommandName.CloseTask:
						this.log(`[API] CloseTask -> ${data}`)
						await vscode.commands.executeCommand("workbench.action.files.saveFiles")
						await vscode.commands.executeCommand("workbench.action.closeWindow")
						break
				}
			})
		}

		this.eventTransformer = new EventTransformer()
		// Initialize streaming server asynchronously to avoid blocking extension startup
		this.initializeProxyServerIfEnabled().catch((error) => {
			console.error("Failed to initialize streaming server during startup:", error)
			this.log("[API] Streaming server initialization failed during startup, continuing without streaming")
		})
	}

	public override emit<K extends keyof RooCodeEvents>(
		eventName: K,
		...args: K extends keyof RooCodeEvents ? RooCodeEvents[K] : never
	) {
		const data = { eventName: eventName as RooCodeEventName, payload: args } as TaskEvent
		this.ipc?.broadcast({ type: IpcMessageType.TaskEvent, origin: IpcOrigin.Server, data })

		// Broadcast to streaming server if available
		this.broadcastToStreamingServer(eventName as RooCodeEventName, ...args)

		return super.emit(eventName, ...args)
	}

	public async startNewTask({
		configuration,
		text,
		images,
		newTab,
		historyItem,
		conversationHistory,
		taskMetadata,
	}: {
		configuration: RooCodeSettings
		text?: string
		images?: string[]
		newTab?: boolean
		historyItem?: any // Existing HistoryItem object
		conversationHistory?: {
			clineMessages?: any[]
			apiMessages?: any[]
		}
		taskMetadata?: {
			taskId?: string
			workspace?: string
		}
	}) {
		let provider: ClineProvider

		if (newTab) {
			await vscode.commands.executeCommand("workbench.action.files.revert")
			await vscode.commands.executeCommand("workbench.action.closeAllEditors")

			provider = await openClineInNewTab({ context: this.context, outputChannel: this.outputChannel })
			this.registerListeners(provider)
		} else {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)

			provider = this.sidebarProvider
		}

		if (configuration) {
			await provider.setValues(configuration)

			if (configuration.allowedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("allowedCommands", configuration.allowedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.deniedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("deniedCommands", configuration.deniedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.commandExecutionTimeout !== undefined) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update(
						"commandExecutionTimeout",
						configuration.commandExecutionTimeout,
						vscode.ConfigurationTarget.Global,
					)
			}
		}

		await provider.removeClineFromStack()
		await provider.postStateToWebview()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })

		let cline: any
		let effectiveHistoryItem = historyItem

		// If conversationHistory is provided, create a synthetic historyItem
		if (
			!effectiveHistoryItem &&
			conversationHistory &&
			(conversationHistory.clineMessages || conversationHistory.apiMessages)
		) {
			const firstMessage = conversationHistory.clineMessages?.[0]
			effectiveHistoryItem = {
				id: taskMetadata?.taskId || crypto.randomUUID(),
				number: 1,
				ts: firstMessage?.ts || Date.now(),
				task: firstMessage?.text || text || "",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				workspace: taskMetadata?.workspace || "unknown",
			}

			// Save the history to disk so it can be loaded by the task
			if (conversationHistory.clineMessages) {
				await this.saveConversationHistory(
					effectiveHistoryItem.id,
					conversationHistory.clineMessages,
					conversationHistory.apiMessages,
				)
			}
		}

		if (effectiveHistoryItem) {
			// Start task with preloaded history
			await provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
			cline = await provider.initClineWithHistoryItem(effectiveHistoryItem)

			// If we have additional text/images to append after loading history
			if (text || images) {
				await provider.postMessageToWebview({ type: "invoke", invoke: "sendMessage", text, images })
			}
		} else {
			// Start fresh task
			await provider.postMessageToWebview({ type: "invoke", invoke: "newChat", text, images })
			cline = await provider.initClineWithTask(text, images, undefined, {
				consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER,
			})
		}

		if (!cline) {
			throw new Error("Failed to create task due to policy restrictions")
		}

		return cline.taskId
	}

	/**
	 * Save conversation history to disk for loading by a task
	 * @private
	 */
	private async saveConversationHistory(taskId: string, clineMessages?: any[], apiMessages?: any[]): Promise<void> {
		try {
			const { saveTaskMessages } = await import("../core/task-persistence/taskMessages")
			const { saveApiMessages } = await import("../core/task-persistence/apiMessages")
			const globalStoragePath = this.sidebarProvider.context.globalStorageUri.fsPath

			if (clineMessages) {
				await saveTaskMessages({
					messages: clineMessages,
					taskId,
					globalStoragePath,
				})
			}

			if (apiMessages) {
				await saveApiMessages({
					messages: apiMessages,
					taskId,
					globalStoragePath,
				})
			}
		} catch (error) {
			console.error("Failed to save conversation history:", error)
			throw error
		}
	}

	public async resumeTask(taskId: string): Promise<void> {
		const { historyItem } = await this.sidebarProvider.getTaskWithId(taskId)
		await this.sidebarProvider.initClineWithHistoryItem(historyItem)
		await this.sidebarProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	public async isTaskInHistory(taskId: string): Promise<boolean> {
		try {
			await this.sidebarProvider.getTaskWithId(taskId)
			return true
		} catch {
			return false
		}
	}

	public getCurrentTaskStack() {
		return this.sidebarProvider.getCurrentTaskStack()
	}

	public async clearCurrentTask(lastMessage?: string) {
		await this.sidebarProvider.finishSubTask(lastMessage ?? "")
		await this.sidebarProvider.postStateToWebview()
	}

	public async cancelCurrentTask() {
		await this.sidebarProvider.cancelTask()
	}

	public async cancelTask(taskId: string) {
		const provider = this.taskMap.get(taskId)

		if (provider) {
			await provider.cancelTask()
			this.taskMap.delete(taskId)
		}
	}

	public async sendMessage(text?: string, images?: string[]) {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "sendMessage", text, images })
	}

	public async pressPrimaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "primaryButtonClick" })
	}

	public async pressSecondaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "secondaryButtonClick" })
	}

	public isReady() {
		return this.sidebarProvider.viewLaunched
	}

	private registerListeners(provider: ClineProvider) {
		provider.on("clineCreated", (cline) => {
			cline.on("taskStarted", async () => {
				this.emit(RooCodeEventName.TaskStarted, cline.taskId)
				this.taskMap.set(cline.taskId, provider)
				await this.fileLog(`[${new Date().toISOString()}] taskStarted -> ${cline.taskId}\n`)
			})

			cline.on("message", async (message) => {
				this.emit(RooCodeEventName.Message, { taskId: cline.taskId, ...message })

				if (message.message.partial !== true) {
					await this.fileLog(`[${new Date().toISOString()}] ${JSON.stringify(message.message, null, 2)}\n`)
				}
			})

			cline.on("taskModeSwitched", (taskId, mode) => this.emit(RooCodeEventName.TaskModeSwitched, taskId, mode))

			cline.on("taskAskResponded", () => this.emit(RooCodeEventName.TaskAskResponded, cline.taskId))

			cline.on("taskAborted", () => {
				this.emit(RooCodeEventName.TaskAborted, cline.taskId)
				this.taskMap.delete(cline.taskId)
			})

			cline.on("taskCompleted", async (_, tokenUsage, toolUsage) => {
				let isSubtask = false

				if (cline.rootTask != undefined) {
					isSubtask = true
				}

				this.emit(RooCodeEventName.TaskCompleted, cline.taskId, tokenUsage, toolUsage, { isSubtask: isSubtask })
				this.taskMap.delete(cline.taskId)

				await this.fileLog(
					`[${new Date().toISOString()}] taskCompleted -> ${cline.taskId} | ${JSON.stringify(tokenUsage, null, 2)} | ${JSON.stringify(toolUsage, null, 2)}\n`,
				)
			})

			cline.on("taskSpawned", (childTaskId) => this.emit(RooCodeEventName.TaskSpawned, cline.taskId, childTaskId))
			cline.on("taskPaused", () => this.emit(RooCodeEventName.TaskPaused, cline.taskId))
			cline.on("taskUnpaused", () => this.emit(RooCodeEventName.TaskUnpaused, cline.taskId))

			cline.on("taskTokenUsageUpdated", (_, usage) =>
				this.emit(RooCodeEventName.TaskTokenUsageUpdated, cline.taskId, usage),
			)

			cline.on("taskToolFailed", (taskId, tool, error) =>
				this.emit(RooCodeEventName.TaskToolFailed, taskId, tool, error),
			)

			this.emit(RooCodeEventName.TaskCreated, cline.taskId)
		})
	}

	// Logging

	private outputChannelLog(...args: unknown[]) {
		for (const arg of args) {
			if (arg === null) {
				this.outputChannel.appendLine("null")
			} else if (arg === undefined) {
				this.outputChannel.appendLine("undefined")
			} else if (typeof arg === "string") {
				this.outputChannel.appendLine(arg)
			} else if (arg instanceof Error) {
				this.outputChannel.appendLine(`Error: ${arg.message}\n${arg.stack || ""}`)
			} else {
				try {
					this.outputChannel.appendLine(
						JSON.stringify(
							arg,
							(key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
				} catch (error) {
					this.outputChannel.appendLine(`[Non-serializable object: ${Object.prototype.toString.call(arg)}]`)
				}
			}
		}
	}

	private async fileLog(message: string) {
		if (!this.logfile) {
			return
		}

		try {
			await fs.appendFile(this.logfile, message, "utf8")
		} catch (_) {
			this.logfile = undefined
		}
	}

	// Global Settings Management

	public getConfiguration(): RooCodeSettings {
		return Object.fromEntries(
			Object.entries(this.sidebarProvider.getValues()).filter(([key]) => !isSecretStateKey(key)),
		)
	}

	public async setConfiguration(values: RooCodeSettings) {
		await this.sidebarProvider.contextProxy.setValues(values)
		await this.sidebarProvider.providerSettingsManager.saveConfig(values.currentApiConfigName || "default", values)
		await this.sidebarProvider.postStateToWebview()
	}

	// Provider Profile Management

	public getProfiles(): string[] {
		return this.sidebarProvider.getProviderProfileEntries().map(({ name }) => name)
	}

	public getProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.sidebarProvider.getProviderProfileEntry(name)
	}

	public async createProfile(name: string, profile?: ProviderSettings, activate: boolean = true) {
		const entry = this.getProfileEntry(name)

		if (entry) {
			throw new Error(`Profile with name "${name}" already exists`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile ?? {}, activate)

		if (!id) {
			throw new Error(`Failed to create profile with name "${name}"`)
		}

		return id
	}

	public async updateProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to update profile with name "${name}"`)
		}

		return id
	}

	public async upsertProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to upsert profile with name "${name}"`)
		}

		return id
	}

	public async deleteProfile(name: string): Promise<void> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.deleteProviderProfile(entry)
	}

	public getActiveProfile(): string | undefined {
		return this.getConfiguration().currentApiConfigName
	}

	public async setActiveProfile(name: string): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.activateProviderProfile({ name })
		return this.getActiveProfile()
	}

	// Roo-Code Streaming Server Integration Methods

	/**
	 * Initialize streaming server if enabled in configuration
	 * @private
	 */
	private async initializeProxyServerIfEnabled(): Promise<void> {
		try {
			const config = this.getStreamingServerConfig()
			if (config.enabled) {
				await this.initializeStreamingServer(config)
				await this.startStreamingServer()
			}
		} catch (error) {
			console.error("Failed to initialize streaming server:", error)
			// Continue without streaming server - don't break core functionality
		}
	}

	/**
	 * Initialize the streaming server with the provided configuration
	 * @param config streaming server configuration
	 */
	public async initializeStreamingServer(config: StreamingServerConfig): Promise<void> {
		if (this.streamingServer) {
			await this.stopStreamingServer()
		}

		this.streamingServer = new StreamingServer({
			port: config.port,
			portRange: config.portRange,
			logging: config.logging,
			loggingLevel: config.loggingLevel,
			connectionTimeout: config.connectionTimeout,
			heartbeatInterval: config.heartbeatInterval,
		})

		// Set up the task command handler for WebSocket clients
		this.streamingServer.setTaskCommandHandler(this.handleWebSocketTaskCommand.bind(this))
	}

	/**
	 * Handle task commands from WebSocket clients
	 */
	private async handleWebSocketTaskCommand(commandName: string, data: any): Promise<void> {
		this.log(`[API] WebSocket TaskCommand: ${commandName} -> ${JSON.stringify(data)}`)

		switch (commandName) {
			case TaskCommandName.StartNewTask:
				this.log(`[API] WebSocket StartNewTask -> ${data.text}, ${JSON.stringify(data.configuration)}`)
				await this.startNewTask(data)
				break
			case TaskCommandName.CancelTask:
				this.log(`[API] WebSocket CancelTask -> ${data}`)
				await this.cancelTask(data)
				break
			case TaskCommandName.CloseTask:
				this.log(`[API] WebSocket CloseTask -> ${data}`)
				await vscode.commands.executeCommand("workbench.action.files.saveFiles")
				await vscode.commands.executeCommand("workbench.action.closeWindow")
				break
			default:
				throw new Error(`Unknown task command: ${commandName}`)
		}
	}

	/**
	 * Start the streaming streaming server
	 * @returns Promise that resolves when server is started
	 */
	public async startStreamingServer(): Promise<void> {
		if (!this.streamingServer) {
			throw new Error("streaming server not initialized. Call initializeStreamingServer first.")
		}

		try {
			await this.streamingServer.start()
			console.log("streaming server started successfully")
			this.log("[API] streaming server started successfully")
		} catch (error) {
			console.error("Failed to start streaming server:", error)
			throw error
		}
	}

	/**
	 * Stop the streaming streaming server
	 * @returns Promise that resolves when server is stopped
	 */
	public async stopStreamingServer(): Promise<void> {
		if (this.streamingServer) {
			try {
				await this.streamingServer.stop()
				this.log("[API] streaming server stopped successfully")
			} catch (error) {
				console.error("Failed to stop streaming server:", error)
				throw error
			} finally {
				this.streamingServer = undefined
			}
		}
	}

	/**
	 * Read streaming server configuration from VSCode workspace settings
	 * @returns streaming server configuration
	 */
	public getStreamingServerConfig(): StreamingServerConfig {
		try {
			const config = vscode.workspace.getConfiguration("roo-cline.streaming")

			// TODO: Support CORS.
			return {
				enabled: config.get<boolean>("enabled", false),
				port: config.get<number>("port", 3051),
				portRange: config.get<{ min: number; max: number }>("portRange", { min: 3050, max: 3100 }),
				logging: config.get<boolean>("logging.enabled", false),
				loggingLevel: config.get<"error" | "warn" | "info" | "debug">("logging.level", "info"),
				connectionTimeout: config.get<number>("connection.timeout", 60000),
				heartbeatInterval: config.get<number>("connection.heartbeatInterval", 30000),
			}
		} catch (error) {
			console.error("Failed to read streaming server configuration:", error)
			// Return safe defaults if configuration reading fails
			return {
				enabled: false,
				port: 3051,
				portRange: { min: 3050, max: 3100 },
				logging: false,
				loggingLevel: "info",
				connectionTimeout: 60000,
				heartbeatInterval: 30000,
			}
		}
	}

	/**
	 * Broadcast events to streaming server
	 * @private
	 */
	private async broadcastToStreamingServer(eventName: RooCodeEventName, ...args: any[]): Promise<void> {
		console.log("broadcasting to streaming server", eventName, args)
		if (!this.streamingServer || !this.eventTransformer) {
			return
		}

		try {
			let streamEvent
			if (eventName === RooCodeEventName.Message && args[0] && args[0].taskId) {
				const messageData = args[0]
				const { taskId, ...clineMessage } = messageData
				streamEvent = this.eventTransformer.transformMessageEvent(taskId, clineMessage.message)
			} else {
				streamEvent = this.eventTransformer.transformTaskEvent(eventName, ...args)
			}
			if (streamEvent) {
				this.streamingServer.broadcastEvent(streamEvent)
			}
		} catch (error) {
			console.error("Failed to broadcast event to streaming server:", error)
		}
	}

	/**
	 * Cleanup resources including streaming server
	 * Call this when the extension is deactivated
	 */
	public async dispose(): Promise<void> {
		try {
			await this.stopStreamingServer()
		} catch (error) {
			console.error("Error during streaming server cleanup:", error)
		}
	}
}
