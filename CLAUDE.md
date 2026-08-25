# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`iobroker.cul` connects a **Busware CUL / COC / SCC / CUNO running culfw** to ioBroker. The stick is
a 868/433 MHz radio transceiver; the adapter listens to everything it receives, creates one device
per `<protocol>.<address>` it hears and writes the decoded datapoints as states. Writing to a
`cmdRaw` state sends a command back out.

TypeScript (CommonJS output). Sources live in `src/`, the published/runnable code is the compiled
`build/` (`package.json` `main` is `build/main.js`). `build/` is gitignored — always run the build
before starting the adapter or the integration tests.

## Commands

```bash
npm run build                      # tsc -p tsconfig.build.json  -> build/
npm run watch                      # same in watch mode
npm run check                      # type check only (tsconfig.json, noEmit)
npm run lint                       # eslint (@iobroker/eslint-config, flat config)
npx eslint -c eslint.config.mjs --fix src   # autofix + prettier formatting

npm run test:package               # validates package.json / io-package.json / admin JSON (fast)
npm run test:integration           # starts a real js-controller + adapter instance
npm run release-major              # @alcalzone/release-script
```

`npm ci`/`npm install` runs `prepare` → `npm run build`, so a fresh checkout is buildable without an
extra step. The integration test requires that **no** js-controller is running on the machine,
otherwise it aborts with "JS-Controller is already running!".

## Architecture

### Layout

| Path | Content |
| --- | --- |
| `src/main.ts` | the whole adapter: one `CulAdapter extends utils.Adapter` class |
| `src/lib/types.ts` | queue tasks, meta roles and the `sendTo` payload shapes |
| `src/lib/adapter-config.d.ts` | augments `ioBroker.AdapterConfig` |
| `admin/jsonConfig.json` | the configuration dialog |
| `admin/i18n/<lang>.json` | flat translations, selected by `"i18n": true` |

`src/lib/adapter-config.d.ts` is hand-maintained and must be kept in sync with `native` in
`io-package.json` **and** with `admin/jsonConfig.json` — nothing generates it.

### The `cul` package

The transport is the npm package `cul` (same author as this adapter). Since 1.0.0 it is

- **ESM only**, so this CommonJS build cannot `require` it. `connect()` loads it with
  `await import('cul')`, and the types come from a `import type … with { 'resolution-mode': 'import' }`
  declaration. TypeScript keeps `import()` intact because `module` is `Node16` — do not switch the
  module setting without re-checking `build/main.js`.
- **self-reconnecting** (every 10 s). The adapter must not build its own reconnect loop; `ready` is
  emitted again after every successful reconnect, `close` whenever the link drops.
- **promise based**: `cmd()`, `write()` and `close()` reject instead of returning `false`.

`serialport` is a separate direct dependency because the adapter needs `SerialPort.list()` for the
admin dropdown and opens the port once in `checkPort()` before `cul` touches it. It is loaded
lazily in `loadSerialPort()`: a missing native binding is only re-thrown when the js-controller
cannot rebuild it (`CONTROLLER_NPM_AUTO_REBUILD`), which is what makes the adapter survive a broken
build of the native module.

### How states are created

`cul.meta.roles` (declared in `io-package.json` `objects`) holds one `common` template per
datapoint name. `createDeviceObjects()` picks the template by `<device>_<datapoint>`, then
`<datapoint>`, then the literal key `undefined` as fallback — so an unknown datapoint becomes a
read-only string. **Adding a datapoint to the roles map is how you give it a type**; without an
entry, booleans and numbers land in a string state.

`queueStates()` converts the value to the type of the already existing state object, which is why
the object task is queued before the state task. Everything goes through the single `tasks` queue
(`processTasks()`), so a burst of radio messages cannot start dozens of parallel DB writes.
`processTasks()` only ever updates `native` of an existing object, never `common` — an object that
exists keeps the `common` it was created with, even if the roles map changed afterwards.

The object cache `objects` is filled once in `main()` from the `system.device`/`system.state`
object views and then kept up to date in memory.

### Datapoint names changed with cul 1.0

`battery` → `batteryLow` (boolean) + `batteryState` (string), `window`/`isopen` → `open`,
`valveposition` → `valvePosition`, and the FHT/MORITZ fields were camel-cased. Old states of
existing installations are simply not written any more. If a datapoint shows up as a string in a
user report, the roles map in `io-package.json` is missing the new name.

### Configuration and `onMessage`

`admin/jsonConfig.json` (`common.adminUI.config = "json"`, admin >= 7). `type` selects the
hardware: everything except `cuno` is a serial connection, `cuno` is telnet — the serial fields are
hidden for `cuno` and the network fields for everything else.

| command | used by | returns |
| --- | --- | --- |
| `listUart5` | `serialport` field (`autocompleteSendTo`) | `{value,label}[]`, with `experimental` the `/dev/serial/by-id` symlinks |
| `listUart` | nothing any more — kept because user scripts may call it | the format of the removed HTML dialog |
| `send` | user scripts | — |
| `sendraw` | user scripts | — |

`send`/`sendraw` are the documented script API (`sendTo('cul.0', 'sendraw', {command: '…'})`), so
those names must not change.

### Writing to the CUL

`onStateChange` only reacts to `cmdRaw` and, unless `config.experimental` is set, only to the
`FS20` protocol — the other protocols are untested, not unimplemented. The id is parsed
positionally: `cul.0.FS20.123401.cmdRaw` → housecode `1234`, address `01`.

Always use `this.setTimeout` / `this.clearTimeout` (adapter-core, auto-cleared on unload), never the
globals.

## Release flow

Changelog lives in `README.md` under the `### **WORK IN PROGRESS**` placeholder comment;
`release-script` (config in `.releaseconfig.json`) moves it into `io-package.json` `common.news`.
CI (`.github/workflows/test-and-release.yml`) type-checks, lints and runs `test:package`, then the
adapter tests on Node 22/24/26 × Linux/Windows/macOS, and publishes to npm on tagged commits.

## Refactoring

`REFACTORING.md` documents the modernisation playbook that this repository was converted with
(gulpfile → tasks.ts, HTML config → JsonConfig, JS → TypeScript). It is meant to be reused for the
other adapters and should be kept in sync when the toolchain moves on.
