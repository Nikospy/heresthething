# heresthething

The local part of [Here's the Thing](https://herestt.mewitzlab.com), a Chrome extension for leaving notes on a live web page. This package connects the extension to Claude Code and Codex on macOS, so your agent can read the notes and mark each one as done.

It contains three programs:

- an installer (`npx heresthething`),
- a native messaging host: the only program the extension can start on your Mac,
- an MCP server that gives your agent the `notes_list`, `notes_read`, `notes_wait` and `notes_status` tools.

The extension works without this package: you can copy notes into any chat. You only need it to send notes to a coding agent.

## Requirements

macOS, Node.js 22 or newer, `git`. Chrome is supported; Arc, Brave, Edge and Vivaldi are detected but not yet verified.

## Install

Use the exact command shown in the extension ("Connect to agent"), for example:

```sh
npx heresthething@0.1.0
```

The installer checks your system, asks which browsers and agents to connect, and shows every change before it writes anything. Nothing is saved until you confirm.

Without questions:

```sh
npx heresthething@0.1.0 --yes --browsers chrome --agents claude,codex
```

Preview only, no changes: `npx heresthething@0.1.0 --dry-run`.

## What it changes on your Mac

1. **Program folder** `~/.config/herestt/`: the native host, the MCP server, a start script, settings, an install journal and a work log.
2. **One manifest file per selected browser**, in that browser's `NativeMessagingHosts` folder. It tells the browser that the Here's the Thing extension, and only that extension, may start the local program.
3. **One entry per selected agent**, added with the agent's own command (`claude mcp add`, `codex mcp add`).
4. **In a project, only when you first send notes:** a `.herestt/` folder with its own `.gitignore`. Your project's `.gitignore` is not changed.

It does not install the extension, change browser settings, grant permissions to agents, run anything in the background (the host starts only when the extension calls it, the MCP server only with your agent), connect to the network, or ask for an administrator password.

Network: `npx` downloads the package from the npm registry once, so npm sees your IP address and the package name. After that everything runs offline.

## Check and remove

```sh
npx heresthething@0.1.0 doctor
```

A read-only report: Node and tools, connection files, a test start of the local program the way Chrome starts it, browsers and agents. Your home folder is shortened to `~`. Exit code 1 means at least one error.

```sh
npx heresthething@0.1.0 undo
```

Removes the local program and only the entries it added. Note mappings and the install journal stay; `undo --all` removes them too. Notes in your projects stay.

## Verify this package

Every version is built and published from this repository by GitHub Actions, with an npm provenance attestation. On npmjs.com the package page has a Provenance section that links the exact commit and workflow run. From the command line:

```sh
npm view heresthething@0.1.0 dist.attestations
```

In a project that depends on the package, `npm audit signatures` verifies the registry signature and the attestation.

## Privacy

The local program does not send data anywhere. Privacy policy: <https://herestt.mewitzlab.com/privacy>.

## License

[PolyForm Shield 1.0.0](LICENSE). You may use, read and change this code, but not to build a product that competes with Here's the Thing.

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
npm pack --dry-run
```

The source of truth is a private repository that also holds the extension. This repository is exported from it, so pull requests are read but changes land through the export.
