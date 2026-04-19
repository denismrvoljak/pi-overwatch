# pi-overwatch

A Pi package by Denis Mrvoljak for monitoring background Pi agents from a dedicated terminal dashboard.

`pi-overwatch` keeps your main tmux workspace untouched. Agents keep running where they already run; Overwatch gives you one separate live board showing what each agent is doing.

## Features

- tmux-aware identity for agent rows
- fallback to Pi session name or cwd basename when tmux is unavailable
- clear dashboard columns for status, target, location, activity, queue, heartbeat, and runtime
- stale detection for agents that stopped heartbeating while still marked as working
- simple package-local configuration via `~/.pi/overwatch/config.json`
- no build step, no runtime dependencies beyond Node and Pi

## Install

### Local path

```bash
pi install /absolute/path/to/pi-overwatch
```

### GitHub

```bash
pi install https://github.com/denismrvoljak/pi-overwatch
```

### Project-local install

```bash
pi install -l https://github.com/denismrvoljak/pi-overwatch
```

### One-off test

```bash
pi -e /absolute/path/to/pi-overwatch
```

## Run the dashboard

Open a dedicated terminal window and run:

```bash
node /absolute/path/to/pi-overwatch/bin/pi-overwatch.js
```

If the package bin is on your PATH, you can also run:

```bash
pi-overwatch
```

## Dashboard columns

- `S` — status icon
- `TARGET` — row identity according to your configured identity mode
- `WHERE` — source context, usually tmux pane like `tmux 1.1`
- `DOING` — current phase or tool
- `SUMMARY` — short activity summary
- `Q` — steering/follow-up queue counts
- `LAST` — seconds since last heartbeat
- `RUN` — elapsed runtime for the current or most recent task

Status icons:

- `●` working
- `✓` done
- `!` stale
- `✕` error
- `○` offline

## Configuration

Overwatch reads config from:

```bash
~/.pi/overwatch/config.json
```

You can start from the example file:

```bash
cp /absolute/path/to/pi-overwatch/config.example.json ~/.pi/overwatch/config.json
```

Example:

```json
{
  "dashboard": {
    "identity": "both",
    "showColumnHeader": true
  }
}
```

### `dashboard.identity`

Supported values:

- `"auto"` — tmux session name, then Pi session name, then cwd basename
- `"tmux"` — prefer tmux session name
- `"cwd"` — show cwd basename only
- `"both"` — show tmux session name plus cwd basename when they differ, e.g. `personal · denis`

### `dashboard.showColumnHeader`

- `true` — show headers under each section
- `false` — hide column headers

## Controls

- `q` quit
- `f` toggle working-only view
- `a` toggle offline rows
- `r` force refresh

## State directory

By default, Overwatch stores data in:

```bash
~/.pi/overwatch
```

Structure:

```text
~/.pi/overwatch/
├── agents/
│   └── <agent-id>.json
├── config.json
└── events.jsonl
```

Override the root directory with:

```bash
export PI_OVERWATCH_DIR=/some/other/path
```

Other environment overrides:

```bash
export PI_OVERWATCH_REFRESH_MS=1000
export PI_OVERWATCH_STALE_MS=30000
```

## How identity works

Overwatch is tmux-aware, not tmux-dependent.

Identity resolution:

1. tmux session name
2. Pi session name
3. cwd basename

So if Pi is launched inside tmux, the row usually follows your tmux session naming model. If tmux is unavailable, Overwatch still works using Pi session names or cwd names.

## Pi command

The extension registers:

```text
/overwatch
```

That command shows the current state file path for the active agent.

## Package structure

```text
pi-overwatch/
├── bin/
│   └── pi-overwatch.js
├── extensions/
│   └── overwatch.ts
├── config.example.json
├── LICENSE
├── package.json
└── README.md
```

## Author

Created by Denis Mrvoljak.

## Notes

- best results come from launching Pi inside the tmux pane you want associated with the row
- the dashboard is intentionally external to tmux session naming and does not rename tmux sessions
- Pi loads the extension directly from TypeScript
- the package uses only Node built-ins and has no build step
