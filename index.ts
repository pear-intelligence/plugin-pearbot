/**
 * PearBot Plugin
 * Spawns autonomous Claude Code agents to build complete software projects
 * from scratch, with real-time progress updates and interactive Q&A.
 */

import type { PluginContext, PluginRegistrations } from "./types"
import { PearBotManager } from "./manager"
import { Elysia } from "elysia"

let manager: PearBotManager | null = null

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false }
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true }
}

export async function activate(ctx: PluginContext): Promise<PluginRegistrations> {
  ctx.log.info("Activating PearBot plugin")

  manager = new PearBotManager(ctx)
  await manager.init()

  return {
    routes: () =>
      new Elysia()
        .get("/projects", () => {
          if (!manager) return { error: "Plugin not active" }
          return manager.listAll()
        })
        .get("/projects/:id", ({ params }) => {
          if (!manager) return { error: "Plugin not active" }
          const projects = manager.getStatus(params.id)
          if (projects.length === 0) return { error: "Project not found" }
          return projects[0]
        })
        .get("/projects/:id/files", ({ params }) => {
          if (!manager) return { error: "Plugin not active" }
          try {
            return { files: manager.listProjectFiles(params.id) }
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) }
          }
        }),

    tools: [
      // ── pearbot_create ────────────────────────────────────
      {
        definition: {
          name: "pearbot_create",
          description:
            "Start building a new software project from scratch. Spawns an autonomous Claude Code agent that will scaffold, code, and test the project. Progress updates and questions will appear in chat.",
          inputSchema: {
            type: "object" as const,
            properties: {
              name: {
                type: "string",
                description: "Short name for the project (used as directory name context)",
              },
              description: {
                type: "string",
                description:
                  "Detailed description of what to build. Be specific about features, UI requirements, etc.",
              },
              tech_stack: {
                type: "string",
                description:
                  "Optional tech stack preference (e.g. 'React + TypeScript', 'Python Flask', 'Next.js')",
              },
            },
            required: ["name", "description"],
          },
        },
        handler: async (args) => {
          if (!manager) return err("Plugin not active")
          try {
            const result = await manager.createProject(
              args.name as string,
              args.description as string,
              args.tech_stack as string | undefined
            )
            return ok(
              `Project "${args.name}" created (ID: ${result.projectId}). Status: ${result.status}.\nPearBot is now working. You'll receive progress updates and any questions in chat.`
            )
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e))
          }
        },
      },

      // ── pearbot_reply ─────────────────────────────────────
      {
        definition: {
          name: "pearbot_reply",
          description:
            "Send a reply to a PearBot agent that is waiting for input. Use this when a builder asks a clarifying question.",
          inputSchema: {
            type: "object" as const,
            properties: {
              project_id: {
                type: "string",
                description: "The project ID to reply to",
              },
              message: {
                type: "string",
                description: "Your response to the builder's question",
              },
            },
            required: ["project_id", "message"],
          },
        },
        handler: async (args) => {
          if (!manager) return err("Plugin not active")
          try {
            const result = await manager.sendToProject(
              args.project_id as string,
              args.message as string
            )
            return ok(`Reply sent to project ${args.project_id}. Status: ${result.status}`)
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e))
          }
        },
      },

      // ── pearbot_status ────────────────────────────────────
      {
        definition: {
          name: "pearbot_status",
          description:
            "Check the status of one or all PearBot project builds. Shows current state and last notification.",
          inputSchema: {
            type: "object" as const,
            properties: {
              project_id: {
                type: "string",
                description: "Specific project ID to check (omit for all projects)",
              },
            },
          },
        },
        handler: async (args) => {
          if (!manager) return err("Plugin not active")
          try {
            const projects = manager.getStatus(args.project_id as string | undefined)
            if (projects.length === 0) {
              return ok(args.project_id ? "Project not found." : "No projects.")
            }

            const lines: string[] = []
            for (const p of projects) {
              lines.push(`${p.name} (${p.id})`)
              lines.push(`  Status: ${p.status}`)
              if (p.techStack) lines.push(`  Tech: ${p.techStack}`)
              if (p.servingPort) lines.push(`  Serving: http://localhost:${p.servingPort}`)
              if (p.lastNotification) {
                lines.push(
                  `  Last update [${p.lastNotification.status}${p.lastNotification.phase ? "/" + p.lastNotification.phase : ""}]: ${p.lastNotification.content.substring(0, 200)}`
                )
              }
              lines.push(`  Created: ${p.createdAt}`)
              lines.push("")
            }

            return ok(lines.join("\n"))
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e))
          }
        },
      },

      // ── pearbot_list ──────────────────────────────────────
      {
        definition: {
          name: "pearbot_list",
          description: "List all PearBot projects with their current states.",
          inputSchema: { type: "object" as const, properties: {}, required: [] },
        },
        handler: async () => {
          if (!manager) return err("Plugin not active")
          const projects = manager.listAll()
          if (projects.length === 0) return ok("No projects yet.")

          const lines = projects.map(
            (p) => `${p.name} (${p.id}) — ${p.status}${p.techStack ? ` [${p.techStack}]` : ""}`
          )
          return ok(`Projects (${projects.length}):\n${lines.join("\n")}`)
        },
      },

      // ── pearbot_open ──────────────────────────────────────
      {
        definition: {
          name: "pearbot_open",
          description:
            "Resume or continue work on an existing project. Spawns a fresh agent that reads existing files for context, then performs the given task.",
          inputSchema: {
            type: "object" as const,
            properties: {
              project_id: {
                type: "string",
                description: "The project ID to open",
              },
              task: {
                type: "string",
                description:
                  "What to do with the project (e.g. 'add dark mode', 'fix the login bug', 'add unit tests')",
              },
            },
            required: ["project_id", "task"],
          },
        },
        handler: async (args) => {
          if (!manager) return err("Plugin not active")
          try {
            const result = await manager.openProject(
              args.project_id as string,
              args.task as string
            )
            return ok(
              `Opened project ${args.project_id} with task: "${(args.task as string).substring(0, 100)}". Status: ${result.status}`
            )
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e))
          }
        },
      },

      // ── pearbot_stop ──────────────────────────────────────
      {
        definition: {
          name: "pearbot_stop",
          description:
            "Stop a running PearBot build agent or dev server for a project.",
          inputSchema: {
            type: "object" as const,
            properties: {
              project_id: {
                type: "string",
                description: "The project ID to stop",
              },
            },
            required: ["project_id"],
          },
        },
        handler: async (args) => {
          if (!manager) return err("Plugin not active")
          try {
            const result = await manager.stopProject(args.project_id as string)
            return ok(
              result.stopped
                ? `Project ${args.project_id} stopped.`
                : `Project ${args.project_id} not found.`
            )
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e))
          }
        },
      },

      // ── pearbot_serve ─────────────────────────────────────
      {
        definition: {
          name: "pearbot_serve",
          description:
            "Start a dev server for a completed project on an available port. Returns the URL.",
          inputSchema: {
            type: "object" as const,
            properties: {
              project_id: {
                type: "string",
                description: "The project ID to serve",
              },
              command: {
                type: "string",
                description:
                  "Custom serve command (e.g. 'npm run dev'). Auto-detected from package.json if omitted.",
              },
            },
            required: ["project_id"],
          },
        },
        handler: async (args) => {
          if (!manager) return err("Plugin not active")
          try {
            const result = await manager.serveProject(
              args.project_id as string,
              args.command as string | undefined
            )
            return ok(
              `Dev server started for project ${args.project_id}.\nURL: ${result.url}\nPort: ${result.port}`
            )
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e))
          }
        },
      },

      // ── pearbot_files ─────────────────────────────────────
      {
        definition: {
          name: "pearbot_files",
          description:
            "List all files in a project directory (excludes node_modules, .git, etc.).",
          inputSchema: {
            type: "object" as const,
            properties: {
              project_id: {
                type: "string",
                description: "The project ID to list files for",
              },
            },
            required: ["project_id"],
          },
        },
        handler: async (args) => {
          if (!manager) return err("Plugin not active")
          try {
            const files = manager.listProjectFiles(args.project_id as string)
            if (files.length === 0) return ok("No files in project directory.")
            return ok(`Files (${files.length}):\n${files.join("\n")}`)
          } catch (e) {
            return err(e instanceof Error ? e.message : String(e))
          }
        },
      },
    ],

    scheduled: [
      {
        name: "pearbot-reminder",
        intervalMs: 10 * 60 * 1000,
        handler: async () => {
          // The manager handles reminders internally via its own interval.
        },
      },
    ],
  }
}

export async function deactivate(): Promise<void> {
  if (manager) {
    await manager.stopAll()
    manager = null
  }
}
