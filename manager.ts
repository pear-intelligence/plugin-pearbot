import { spawn, type Subprocess } from "bun"
import { EventEmitter } from "events"
import { join, resolve } from "path"
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync } from "fs"
import { createServer } from "net"
import type { PluginContext, ProjectMetadata, ProjectNotification, ProjectStatus } from "./types"

type BunSubprocess = Subprocess<"pipe", "pipe", "pipe">

const WAITING_REMINDER_INTERVAL_MS = 10 * 60 * 1000
const COMPLETED_CLEANUP_MS = 30 * 60 * 1000
const STALLED_AGENT_TIMEOUT_MS = 60 * 60 * 1000

/**
 * PearBot — Manages project builder Claude Code subprocesses.
 * Follows the BrowserbaseProcessManager pattern — spawns Claude Code CLI
 * subprocesses that communicate via NDJSON stdin/stdout.
 */
export class PearBotManager extends EventEmitter {
  private projects: Map<string, ProjectMetadata> = new Map()
  private agentProcesses: Map<string, BunSubprocess> = new Map()
  private serverProcesses: Map<string, Subprocess> = new Map()
  private allocatedPorts: Set<number> = new Set()
  private ctx: PluginContext
  private projectsDir: string
  private portRangeStart: number
  private portRangeEnd: number
  private maxConcurrentBuilds: number
  private publicHost: string
  private reminderInterval: ReturnType<typeof setInterval> | null = null
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private stalledCheckInterval: ReturnType<typeof setInterval> | null = null
  private claudeMdPath: string

  constructor(ctx: PluginContext) {
    super()
    this.ctx = ctx
    this.projectsDir = resolve(
      process.cwd(),
      ctx.getSetting<string>("projectsDir") || "projects"
    )
    this.portRangeStart = ctx.getSetting<number>("portRangeStart") || 4000
    this.portRangeEnd = ctx.getSetting<number>("portRangeEnd") || 4999
    this.maxConcurrentBuilds = ctx.getSetting<number>("maxConcurrentBuilds") || 3
    this.publicHost = ctx.getSetting<string>("publicHost") || ""
    this.claudeMdPath = join(
      resolve(process.cwd(), "plugins", "pearbot"),
      "CLAUDE.md"
    )

    // Wire up notification forwarding to main Claude
    this.on("notification", ({ projectId, notification }: { projectId: string; notification: ProjectNotification }) => {
      this.forwardNotification(projectId, notification)
    })

    this.startReminderInterval()
    this.startCleanupInterval()
    this.startStalledCheckInterval()
  }

  // ── Initialization ──────────────────────────────────────────

  async init(): Promise<void> {
    // Create projects directory
    if (!existsSync(this.projectsDir)) {
      mkdirSync(this.projectsDir, { recursive: true })
    }

    // Create DB table
    const db = this.ctx.getDb() as { run: (sql: string) => void; query: (sql: string) => { all: () => Record<string, unknown>[] } }
    db.run(`
      CREATE TABLE IF NOT EXISTS pearbot_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        tech_stack TEXT,
        status TEXT NOT NULL DEFAULT 'creating',
        directory TEXT NOT NULL,
        serving_port INTEGER,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        waiting_since TEXT,
        last_notification_json TEXT
      )
    `)

    // Load existing projects from DB
    const rows = db.query("SELECT * FROM pearbot_projects").all()
    for (const row of rows) {
      const project: ProjectMetadata = {
        id: row.id as string,
        name: row.name as string,
        description: row.description as string,
        techStack: (row.tech_stack as string) || null,
        status: (row.status as ProjectStatus) === "building" || (row.status as ProjectStatus) === "creating"
          ? "stopped"
          : row.status as ProjectStatus,
        directory: row.directory as string,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
        waitingSince: (row.waiting_since as string) || null,
        lastNotification: row.last_notification_json
          ? JSON.parse(row.last_notification_json as string)
          : null,
        servingPort: (row.serving_port as number) || null,
        serverProcess: null,
        agentProcess: null,
        sessionId: (row.session_id as string) || null,
        outputBuffer: "",
      }
      this.projects.set(project.id, project)
    }

    this.ctx.log.info(`PearBot initialized. ${this.projects.size} existing project(s). Dir: ${this.projectsDir}`)
  }

  // ── Project Creation ────────────────────────────────────────

  async createProject(
    name: string,
    description: string,
    techStack?: string
  ): Promise<{ projectId: string; status: ProjectStatus }> {
    const running = this.getRunningCount()
    if (running >= this.maxConcurrentBuilds) {
      throw new Error(
        `Max concurrent builds reached (${this.maxConcurrentBuilds}). Stop a running project first.`
      )
    }

    const projectId = `proj_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    const projectDir = join(this.projectsDir, projectId)
    mkdirSync(projectDir, { recursive: true })

    const now = new Date().toISOString()
    const project: ProjectMetadata = {
      id: projectId,
      name,
      description,
      techStack: techStack || null,
      status: "creating",
      directory: projectDir,
      createdAt: now,
      updatedAt: now,
      waitingSince: null,
      lastNotification: null,
      servingPort: null,
      serverProcess: null,
      agentProcess: null,
      sessionId: null,
      outputBuffer: "",
    }

    this.projects.set(projectId, project)
    this.saveProject(project)

    this.ctx.log.info(`Creating project ${projectId}: ${name}`)

    await this.spawnAgent(projectId, this.buildCreatePrompt(name, description, techStack))

    return { projectId, status: "creating" }
  }

  // ── Open/Resume Project ─────────────────────────────────────

  async openProject(
    projectId: string,
    task: string
  ): Promise<{ status: ProjectStatus }> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Project ${projectId} not found`)

    if (this.agentProcesses.has(projectId)) {
      this.killAgentProcess(projectId)
    }

    const running = this.getRunningCount()
    if (running >= this.maxConcurrentBuilds) {
      throw new Error(
        `Max concurrent builds reached (${this.maxConcurrentBuilds}). Stop a running project first.`
      )
    }

    const prompt = [
      `You are resuming work on an existing project called "${project.name}".`,
      `Project description: ${project.description}`,
      project.techStack ? `Tech stack: ${project.techStack}` : "",
      "",
      "FIRST: Explore the existing files in this directory to understand what has already been built.",
      "THEN: Perform this task:",
      "",
      task,
    ]
      .filter(Boolean)
      .join("\n")

    project.status = "building"
    project.updatedAt = new Date().toISOString()
    this.saveProject(project)

    await this.spawnAgent(projectId, prompt)

    return { status: "building" }
  }

  // ── Send Message to Agent ───────────────────────────────────

  async sendToProject(projectId: string, message: string): Promise<{ status: ProjectStatus }> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Project ${projectId} not found`)

    const proc = this.agentProcesses.get(projectId)
    if (!proc?.stdin) {
      throw new Error(`Project ${projectId} agent not running`)
    }

    const payload =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: message },
      }) + "\n"

    this.ctx.log.info(`>>> Project ${projectId}: ${message.substring(0, 100)}...`)

    proc.stdin.write(payload)
    proc.stdin.flush()

    project.status = "building"
    project.waitingSince = null
    project.updatedAt = new Date().toISOString()
    this.saveProject(project)

    return { status: "building" }
  }

  // ── Status & Listing ────────────────────────────────────────

  getStatus(projectId?: string): ProjectMetadata[] {
    if (projectId) {
      const p = this.projects.get(projectId)
      return p ? [this.sanitizeProject(p)] : []
    }
    return Array.from(this.projects.values()).map((p) => this.sanitizeProject(p))
  }

  listAll(): Array<{
    id: string
    name: string
    status: ProjectStatus
    techStack: string | null
    createdAt: string
    updatedAt: string
  }> {
    return Array.from(this.projects.values()).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      techStack: p.techStack,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }))
  }

  listProjectFiles(projectId: string): string[] {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Project ${projectId} not found`)
    if (!existsSync(project.directory)) return []
    return this.walkDir(project.directory, project.directory)
  }

  // ── Stop Project ────────────────────────────────────────────

  async stopProject(projectId: string): Promise<{ stopped: boolean }> {
    const project = this.projects.get(projectId)
    if (!project) return { stopped: false }

    this.killAgentProcess(projectId)
    this.killServerProcess(projectId)

    project.status = "stopped"
    project.updatedAt = new Date().toISOString()
    this.saveProject(project)

    return { stopped: true }
  }

  // ── Dev Server ──────────────────────────────────────────────

  async serveProject(
    projectId: string,
    command?: string
  ): Promise<{ port: number; url: string }> {
    const project = this.projects.get(projectId)
    if (!project) throw new Error(`Project ${projectId} not found`)

    this.killServerProcess(projectId)

    const port = await this.findAvailablePort()
    this.allocatedPorts.add(port)

    // Find the actual project root (agent may create a nested subdirectory)
    const serveDir = this.findProjectRoot(project.directory)
    const cmd = command || this.detectServeCommand(serveDir)
    const parts = cmd.split(" ")

    this.ctx.log.info(`Serving project ${projectId} on port ${port} in ${serveDir}: ${cmd}`)

    const env = { ...process.env, PORT: String(port) }
    const proc = spawn(parts, {
      cwd: serveDir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })

    this.serverProcesses.set(projectId, proc)

    // Wait briefly to catch immediate failures (exit 127 = command not found, etc.)
    const earlyExit = await Promise.race([
      proc.exited.then((code) => code),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ])

    if (earlyExit !== null) {
      this.allocatedPorts.delete(port)
      this.serverProcesses.delete(projectId)
      project.status = "failed"
      project.updatedAt = new Date().toISOString()
      this.saveProject(project)
      throw new Error(
        `Dev server exited immediately with code ${earlyExit}. Command: "${cmd}" in ${serveDir}`
      )
    }

    proc.exited.then((exitCode) => {
      this.ctx.log.info(`Dev server for ${projectId} exited with code ${exitCode}`)
      this.allocatedPorts.delete(port)
      this.serverProcesses.delete(projectId)
      const p = this.projects.get(projectId)
      if (p && p.status === "serving") {
        p.status = "completed"
        p.servingPort = null
        p.updatedAt = new Date().toISOString()
        this.saveProject(p)
      }
    })

    project.status = "serving"
    project.servingPort = port
    project.updatedAt = new Date().toISOString()
    this.saveProject(project)

    const host = this.publicHost || "localhost"
    const protocol = this.publicHost ? "https" : "http"
    const url = `${protocol}://${host}:${port}`
    return { port, url }
  }

  // ── Stop All ────────────────────────────────────────────────

  async stopAll(): Promise<void> {
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval)
      this.reminderInterval = null
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    if (this.stalledCheckInterval) {
      clearInterval(this.stalledCheckInterval)
      this.stalledCheckInterval = null
    }

    for (const projectId of this.projects.keys()) {
      this.killAgentProcess(projectId)
      this.killServerProcess(projectId)
    }

    this.allocatedPorts.clear()
  }

  // ── Private: Agent Spawning ─────────────────────────────────

  private async spawnAgent(projectId: string, initialPrompt: string): Promise<void> {
    const project = this.projects.get(projectId)
    if (!project) return

    let systemPrompt = ""
    try {
      systemPrompt = readFileSync(this.claudeMdPath, "utf-8")
    } catch {
      this.ctx.log.warn("Could not read CLAUDE.md system prompt")
    }

    const args = [
      "-p",
      "--verbose",
      "--dangerously-skip-permissions",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
    ]

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt)
    }

    const proc = spawn(["claude", ...args], {
      cwd: project.directory,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as BunSubprocess

    this.agentProcesses.set(projectId, proc)
    project.agentProcess = proc

    this.readOutputStream(projectId)
    this.readErrorStream(projectId)

    proc.exited.then((exitCode) => {
      this.ctx.log.info(`Agent for ${projectId} exited with code: ${exitCode}`)
      this.agentProcesses.delete(projectId)
      const p = this.projects.get(projectId)
      if (p) {
        p.agentProcess = null
        if (p.status === "building" || p.status === "creating") {
          p.status = exitCode === 0 ? "completed" : "failed"
        }
        p.updatedAt = new Date().toISOString()
        this.saveProject(p)
        this.emit("agentExit", { projectId, exitCode })
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 2000))

    const payload =
      JSON.stringify({
        type: "user",
        message: { role: "user", content: initialPrompt },
      }) + "\n"

    proc.stdin.write(payload)
    proc.stdin.flush()

    project.status = "building"
    project.updatedAt = new Date().toISOString()
    this.saveProject(project)
  }

  // ── Private: NDJSON Output Parsing ──────────────────────────

  private async readOutputStream(projectId: string): Promise<void> {
    const proc = this.agentProcesses.get(projectId)
    if (!proc?.stdout) return

    const project = this.projects.get(projectId)
    if (!project) return

    const stdout = proc.stdout as ReadableStream<Uint8Array>
    const reader = stdout.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        project.outputBuffer += decoder.decode(value, { stream: true })

        const lines = project.outputBuffer.split("\n")
        project.outputBuffer = lines.pop() || ""

        for (const line of lines) {
          if (!line.trim()) continue

          try {
            const message = JSON.parse(line)

            if (message.type === "system" && message.subtype === "init" && message.session_id) {
              project.sessionId = message.session_id
            }

            if (message.type === "assistant") {
              const content = message.message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && block.text) {
                    const notification = this.parseNotification(block.text)
                    if (notification) {
                      project.lastNotification = notification
                      project.updatedAt = new Date().toISOString()

                      if (notification.status === "success") {
                        project.status = "completed"
                        project.waitingSince = null
                      } else if (notification.status === "failed") {
                        project.status = "failed"
                        project.waitingSince = null
                      } else if (notification.status === "clarify") {
                        project.status = "waiting_for_input"
                        project.waitingSince = new Date().toISOString()
                      }

                      this.saveProject(project)
                      this.emit("notification", { projectId, notification })
                    }
                  }
                }
              }
            }

            if (message.type === "result") {
              const p = this.projects.get(projectId)
              if (p && p.status === "building") {
                // Agent turn ended — stays in building state
              }
            }

            this.emit("message", { projectId, message })
          } catch {
            // Not valid JSON, skip
          }
        }
      }
    } catch (error) {
      this.ctx.log.error(`Error reading agent ${projectId} stdout:`, error)
    }
  }

  private async readErrorStream(projectId: string): Promise<void> {
    const proc = this.agentProcesses.get(projectId)
    if (!proc?.stderr) return

    const stderr = proc.stderr as ReadableStream<Uint8Array>
    const reader = stderr.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        if (text.trim()) {
          const trimmed = text.trim()
          if (trimmed.length > 0 && !trimmed.startsWith("Debugger")) {
            this.ctx.log.info(`[pearbot-stderr ${projectId}] ${trimmed.substring(0, 200)}`)
          }
        }
      }
    } catch (error) {
      this.ctx.log.error(`Error reading agent ${projectId} stderr:`, error)
    }
  }

  // ── Private: Notification Parsing ───────────────────────────

  private parseNotification(text: string): ProjectNotification | null {
    const match = text.match(
      /<pearbot\s+status="(\w+)"(?:\s+phase="([^"]*)")?>([\s\S]*?)<\/pearbot>/
    )
    if (!match) return null

    return {
      status: match[1] as ProjectNotification["status"],
      phase: match[2] || undefined,
      content: match[3].trim(),
    }
  }

  // ── Private: Notification Forwarding ────────────────────────

  private async forwardNotification(
    projectId: string,
    notification: ProjectNotification
  ): Promise<void> {
    const project = this.projects.get(projectId)
    const projectLabel = project ? `"${project.name}" (${projectId})` : projectId

    try {
      switch (notification.status) {
        case "clarify":
          await this.ctx.sendClaudeMessage(
            `<system>PEARBOT ${projectLabel} needs input: ${notification.content}\nUse the pearbot_reply tool with project_id="${projectId}" to respond.</system>`
          )
          break

        case "progress":
          await this.ctx.sendClaudeMessage(
            `<system>PEARBOT ${projectLabel} progress${notification.phase ? ` [${notification.phase}]` : ""}: ${notification.content}</system>`
          )
          break

        case "success":
          await this.ctx.sendClaudeMessage(
            `<system>PEARBOT ${projectLabel} completed successfully: ${notification.content}</system>`
          )
          break

        case "failed":
          await this.ctx.sendClaudeMessage(
            `<system>PEARBOT ${projectLabel} failed: ${notification.content}</system>`
          )
          break
      }
    } catch (error) {
      this.ctx.log.error(`Failed to forward notification for ${projectId}:`, error)
    }
  }

  // ── Private: Intervals ──────────────────────────────────────

  private startReminderInterval(): void {
    this.reminderInterval = setInterval(async () => {
      const waiting = Array.from(this.projects.values()).filter(
        (p) => p.status === "waiting_for_input"
      )
      if (waiting.length > 0) {
        const summaries = waiting
          .map((p) => `- "${p.name}" (${p.id}): ${p.lastNotification?.content?.substring(0, 100) || "awaiting response"}`)
          .join("\n")
        try {
          await this.ctx.sendClaudeMessage(
            `<system>REMINDER: ${waiting.length} PearBot project(s) waiting for input:\n${summaries}\nUse pearbot_reply tool to respond.</system>`
          )
        } catch {
          // Ignore send failures
        }
      }
    }, WAITING_REMINDER_INTERVAL_MS)
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      for (const [id, project] of this.projects) {
        if (
          (project.status === "completed" || project.status === "failed" || project.status === "stopped") &&
          Date.now() - new Date(project.updatedAt).getTime() > COMPLETED_CLEANUP_MS
        ) {
          // Don't delete from disk, just remove from memory
        }
      }
    }, COMPLETED_CLEANUP_MS)
  }

  private startStalledCheckInterval(): void {
    this.stalledCheckInterval = setInterval(() => {
      const now = Date.now()
      for (const [id, project] of this.projects) {
        if (
          (project.status === "building" || project.status === "creating") &&
          this.agentProcesses.has(id)
        ) {
          const runtime = now - new Date(project.createdAt).getTime()
          if (runtime > STALLED_AGENT_TIMEOUT_MS) {
            this.ctx.log.warn(`Agent for ${id} stalled (${Math.round(runtime / 60000)} min), killing`)
            this.killAgentProcess(id)
            project.status = "failed"
            project.lastNotification = {
              status: "failed",
              content: "Agent timed out after 1 hour",
            }
            project.updatedAt = new Date().toISOString()
            this.saveProject(project)
            this.emit("notification", {
              projectId: id,
              notification: project.lastNotification,
            })
          }
        }
      }
    }, 5 * 60 * 1000)
  }

  // ── Private: Helpers ────────────────────────────────────────

  private getRunningCount(): number {
    let count = 0
    for (const p of this.projects.values()) {
      if (p.status === "building" || p.status === "creating") count++
    }
    return count
  }

  private killAgentProcess(projectId: string): void {
    const proc = this.agentProcesses.get(projectId)
    if (proc) {
      try { proc.kill() } catch { /* Already dead */ }
      this.agentProcesses.delete(projectId)
    }
    const project = this.projects.get(projectId)
    if (project) project.agentProcess = null
  }

  private killServerProcess(projectId: string): void {
    const proc = this.serverProcesses.get(projectId)
    if (proc) {
      try { proc.kill() } catch { /* Already dead */ }
      this.serverProcesses.delete(projectId)
    }
    const project = this.projects.get(projectId)
    if (project) {
      if (project.servingPort) this.allocatedPorts.delete(project.servingPort)
      project.servingPort = null
      project.serverProcess = null
    }
  }

  private async findAvailablePort(): Promise<number> {
    for (let port = this.portRangeStart; port <= this.portRangeEnd; port++) {
      if (this.allocatedPorts.has(port)) continue
      const available = await this.testPort(port)
      if (available) return port
    }
    throw new Error(`No available ports in range ${this.portRangeStart}-${this.portRangeEnd}`)
  }

  private testPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer()
      server.once("error", () => resolve(false))
      server.once("listening", () => { server.close(() => resolve(true)) })
      server.listen(port, "127.0.0.1")
    })
  }

  private findProjectRoot(directory: string): string {
    // If package.json (or manage.py, etc.) is directly here, use this dir
    if (existsSync(join(directory, "package.json")) || existsSync(join(directory, "manage.py"))) {
      return directory
    }
    // Otherwise check one level of subdirectories (agent often creates a named subfolder)
    try {
      const entries = readdirSync(directory)
      for (const entry of entries) {
        const sub = join(directory, entry)
        try {
          if (statSync(sub).isDirectory() && !entry.startsWith(".") && entry !== "node_modules") {
            if (existsSync(join(sub, "package.json")) || existsSync(join(sub, "manage.py"))) {
              return sub
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* fall through */ }
    return directory
  }

  private detectServeCommand(directory: string): string {
    const bindAll = this.publicHost ? true : false
    const pkgPath = join(directory, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
        // Detect Next.js
        const isNext = pkg.dependencies?.next || pkg.devDependencies?.next
        const hostFlag = bindAll ? (isNext ? " --hostname 0.0.0.0" : "") : ""
        if (pkg.scripts?.dev) return `npm run dev${hostFlag}`
        if (pkg.scripts?.start) return `npm start${hostFlag}`
        if (pkg.scripts?.serve) return `npm run serve${hostFlag}`
      } catch { /* Fall through */ }
    }
    if (existsSync(join(directory, "manage.py"))) {
      return bindAll ? "python manage.py runserver 0.0.0.0" : "python manage.py runserver"
    }
    if (existsSync(join(directory, "app.py"))) {
      return bindAll ? "python app.py --host 0.0.0.0" : "python app.py"
    }
    return "npm start"
  }

  private saveProject(project: ProjectMetadata): void {
    try {
      const db = this.ctx.getDb() as { run: (sql: string, ...params: unknown[]) => void }
      db.run(
        `INSERT OR REPLACE INTO pearbot_projects
         (id, name, description, tech_stack, status, directory, serving_port, session_id, created_at, updated_at, waiting_since, last_notification_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        project.id, project.name, project.description, project.techStack,
        project.status, project.directory, project.servingPort, project.sessionId,
        project.createdAt, project.updatedAt, project.waitingSince,
        project.lastNotification ? JSON.stringify(project.lastNotification) : null
      )
    } catch (error) {
      this.ctx.log.error(`Failed to save project ${project.id}:`, error)
    }
  }

  private sanitizeProject(p: ProjectMetadata): ProjectMetadata {
    return { ...p, agentProcess: null, serverProcess: null, outputBuffer: "" }
  }

  private buildCreatePrompt(name: string, description: string, techStack?: string): string {
    const parts = [`Build a complete project called "${name}".`, "", `Description: ${description}`]
    if (techStack) parts.push(`Tech stack: ${techStack}`)
    parts.push("", "Build this project from scratch in the current directory.", "Follow the instructions in your system prompt for communication protocol and workflow.")
    return parts.join("\n")
  }

  private walkDir(dir: string, root: string): string[] {
    const results: string[] = []
    const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv"])
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (skipDirs.has(entry)) continue
        const fullPath = join(dir, entry)
        try {
          const stat = statSync(fullPath)
          const relativePath = fullPath.replace(root + "/", "")
          if (stat.isDirectory()) {
            results.push(relativePath + "/")
            results.push(...this.walkDir(fullPath, root))
          } else {
            results.push(relativePath)
          }
        } catch { /* Skip inaccessible files */ }
      }
    } catch { /* Directory doesn't exist or inaccessible */ }
    return results
  }
}
