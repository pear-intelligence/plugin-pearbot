<p align="center">
  <img src="https://img.shields.io/badge/pear-plugin-22c55e?style=for-the-badge&labelColor=0a0a0a" alt="Pear Plugin" />
  <img src="https://img.shields.io/badge/version-1.0.0-white?style=for-the-badge&labelColor=0a0a0a" alt="Version" />
  <img src="https://img.shields.io/badge/runtime-bun-f472b6?style=for-the-badge&labelColor=0a0a0a" alt="Bun" />
</p>

<h1 align="center">PearBot</h1>

<p align="center">
  <strong>Autonomous project builder for <a href="https://github.com/pear-intelligence">Pear</a></strong><br/>
  <sub>Spawns Claude Code agents that scaffold, code, test, and ship complete software projects — right from chat.</sub>
</p>

---

## How it works

PearBot bridges your Pear chat with dedicated Claude Code subprocesses. When you ask Pear to build something, PearBot:

1. **Spins up an agent** in an isolated project directory
2. **Streams progress** back to your conversation in real time
3. **Asks questions** when it needs clarification (you reply naturally in chat)
4. **Builds everything** — scaffolding, dependencies, application code, styles, tests, README
5. **Serves the result** on a local dev server so you can preview instantly

Each builder agent runs the full Claude Code toolchain (Bash, Read, Write, Edit, Glob, Grep) and follows a structured communication protocol using XML status tags to keep you informed at every step.

## Tools

PearBot exposes **8 tools** to the main Pear assistant:

| Tool | Description |
|:-----|:------------|
| `pearbot_create` | Start a new project from a name + description (optionally specify tech stack) |
| `pearbot_reply` | Send your answer when a builder asks a clarifying question |
| `pearbot_status` | Check the current state of one or all builds |
| `pearbot_list` | Quick summary of every project and its status |
| `pearbot_open` | Resume work on an existing project with a new task |
| `pearbot_stop` | Kill a running builder agent or dev server |
| `pearbot_serve` | Launch a dev server for a completed project and get the URL |
| `pearbot_files` | List all files in a project directory |

## REST API

Routes are available under the plugin's prefix:

```
GET /projects          — list all projects
GET /projects/:id      — project detail
GET /projects/:id/files — file listing
```

## Configuration

| Setting | Type | Default | Description |
|:--------|:-----|:--------|:------------|
| `projectsDir` | string | `projects` | Where project directories are created (relative to server root) |
| `maxConcurrentBuilds` | number | `3` | Max simultaneous builder agents (1–10) |
| `portRangeStart` | number | `4000` | Start of the port range for dev servers |
| `portRangeEnd` | number | `4999` | End of the port range for dev servers |

## Project lifecycle

```
  pearbot_create
       │
       ▼
   ┌────────┐     ┌──────────────────┐
   │creating│────▶│    building       │◀─── pearbot_open
   └────────┘     └──────┬───────────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
       ┌───────────┐ ┌────────┐ ┌──────┐
       │waiting_for│ │completed│ │failed│
       │  _input   │ └───┬────┘ └──────┘
       └─────┬─────┘     │
             │            ▼
    pearbot_reply    pearbot_serve
             │            │
             ▼            ▼
         building     ┌───────┐
                      │serving│
                      └───────┘
```

## Builder agent protocol

Each spawned agent communicates via NDJSON over stdin/stdout. Status updates are embedded as XML tags in the agent's text responses:

```xml
<pearbot status="progress" phase="scaffolding">
  Created Next.js project with TypeScript and Tailwind CSS.
</pearbot>

<pearbot status="clarify">
  Should the dashboard use a sidebar or top-nav layout?
</pearbot>

<pearbot status="success">
  Project complete. Run `npm run dev` to start.
</pearbot>
```

Valid phases: `planning` · `scaffolding` · `dependencies` · `coding` · `styling` · `testing` · `documentation` · `finalizing`

## File structure

```
pearbot/
├── plugin.json    — manifest & settings schema
├── types.ts       — shared type definitions
├── CLAUDE.md      — system prompt for builder agents
├── manager.ts     — PearBotManager (process lifecycle, NDJSON, notifications)
└── index.ts       — plugin entry point (tools, routes, scheduled tasks)
```

## Installation

Place the plugin in your Pear `plugins/` directory and enable it from settings. No additional dependencies beyond the Pear runtime.

---

<p align="center">
  <sub>Built by <a href="https://github.com/pear-intelligence">Pear Intelligence</a></sub>
</p>
