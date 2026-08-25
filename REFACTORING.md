# REFACTORING.md — Modernisierung eines ioBroker-Adapters

Arbeitsanleitung für Claude Code (und Menschen), um einen "alten" ioBroker-Adapter auf den
aktuellen Standard zu heben:

1. `gulpfile.js` → `tasks.ts` (bzw. ersatzlos entfernen)
2. HTML-Admin (`index_m.html` + `words.js`) → **JsonConfig** (`admin/jsonConfig.json`)
3. JS-Backend (`main.js`, `lib/*.js`) → **TypeScript 6** in `src/`, Build nach `build/`

**Referenzprojekt:** `C:\pWork\ioBroker.hm-rega`
Der komplette Umbau steckt dort in einem Commit — immer zuerst dort nachschauen:

```bash
cd /c/pWork/ioBroker.hm-rega
git show --stat adbf876          # "Refactoring 260815" – die Datei-für-Datei-Blaupause
git show adbf876 -- package.json io-package.json tsconfig.json
```

Weitere lokale Referenzen:

| Thema                                          | Pfad                                                                  |
|------------------------------------------------|-----------------------------------------------------------------------|
| Reines JsonConfig + TS, kein React             | `C:\pWork\ioBroker.hm-rega`                                           |
| `tasks.ts` mit React-Admin (ts-node)           | `C:\pWork\ioBroker.modbus`                                            |
| `tasks.ts` mit Backend + Admin + Widgets (tsx) | `C:\pWork\ioBroker.scheduler`                                         |
| Alle JsonConfig-Controls als Beispiel          | `C:\pWork\ioBroker.jsonconfig-demo\admin\jsonConfig.json5`            |
| JSON-Schema für JsonConfig                     | `C:\pWork\ioBroker.admin\packages\jsonConfig\schemas\jsonConfig.json` |

---

## 0. Grundregeln

- **Verhalten nicht ändern.** Das Refactoring ist eine Übersetzung, kein Redesign. Objekt-IDs,
  State-Rollen, `native`-Feldnamen, `sendTo`-Kommandos und Default-Werte bleiben **exakt** gleich,
  sonst brechen bestehende Installationen.
- Wenn beim Übersetzen ein echter Bug auffällt: notieren, aber **separat** fixen (eigener Commit),
  damit der Diff überprüfbar bleibt.
- Absichtliche Altlasten ("sieht falsch aus, ist aber Absicht") als Kommentar im TS-Code festhalten.
- Zwischendurch immer wieder `npm run build && npm run lint && npm run test:package` laufen lassen.
- Auf einem Branch arbeiten: `git checkout -b refactoring`.

---

## 1. Zielbild

| Vorher                                                     | Nachher                                                                |
|------------------------------------------------------------|------------------------------------------------------------------------|
| `main.js`, `lib/*.js`                                      | `src/main.ts`, `src/lib/*.ts` → kompiliert nach `build/` (gitignored)  |
| `package.json` `main: main.js`                             | `main: build/main.js`, `files: ["build/", "admin/", …]`                |
| `gulpfile.js` + `gulp`                                     | `tasks.ts` (nur wenn es wirklich etwas zu bauen gibt), sonst gelöscht  |
| `admin/index.html`, `admin/index_m.html`, `admin/words.js` | `admin/jsonConfig.json`                                                |
| `admin/i18n/<lang>/translations.json`                      | `admin/i18n/<lang>.json` (flach) + `"i18n": true`                      |
| `common.materialize: true`                                 | `common.adminUI: { "config": "json" }`                                 |
| `.eslintrc.json`, `.prettierrc.json`                       | `eslint.config.mjs`, `prettier.config.mjs` (`@iobroker/eslint-config`) |
| `@iobroker/legacy-testing`, eigenes `test/lib/setup.js`    | `@iobroker/testing` v5                                                 |
| —                                                          | `tsconfig.json` (Check) + `tsconfig.build.json` (Emit)                 |
| —                                                          | `src/lib/adapter-config.d.ts` (typisiertes `this.config`)              |
| —                                                          | `CLAUDE.md` (Architektur-Doku für die nächste Session)                 |

Ziel-Dateibaum (Adapter ohne React-Admin, z. B. hm-rega / cul):

```
admin/
  jsonConfig.json
  i18n/{en,de,ru,pt,nl,fr,it,es,pl,zh-cn}.json
  <adapter>.png
src/
  main.ts
  lib/adapter-config.d.ts
  lib/types.ts
  lib/*.ts
test/
  packageFiles.js
  integrationAdapter.js
  unitAdapter.js
build/            <- generiert, .gitignore
eslint.config.mjs
prettier.config.mjs
tsconfig.json
tsconfig.build.json
io-package.json
package.json
CLAUDE.md
REFACTORING.md
```

---

## 2. Etappe 0 — Bestandsaufnahme

Vor der ersten Änderung:

```bash
git status                                  # muss sauber sein
node -p "JSON.stringify(require('./package.json'),null,2)"
node -p "JSON.stringify(require('./io-package.json').common,null,2)"
node -p "Object.keys(require('./io-package.json').native)"
ls admin lib test
wc -l main.js lib/*.js admin/index_m.html admin/words.js
grep -n "gulp.task(" gulpfile.js
```

Daraus eine **Merkliste** anlegen (in der Antwort an den User, nicht als Datei):

- Liste aller `native.*`-Keys mit Typ und Default → daraus entstehen später
  `adapter-config.d.ts` **und** `jsonConfig.json`.
- Liste aller `adapter.on(...)`-Handler und aller `sendTo`-Kommandos (`onMessage`).
- Fremd-npm-Module ohne Typings (brauchen `@types/*` oder ein eigenes `.d.ts`).
- Alles, was der `gulpfile.js` außer `translate` / `updateReadme` / `words2languages` noch tut.

---

## 3. Etappe 1 — Toolchain

### 3.1 `package.json`

Vorlage (Versionen gegen `C:\pWork\ioBroker.hm-rega\package.json` abgleichen, dort steht der
jeweils aktuelle Stand):

```jsonc
{
  "main": "build/main.js",
  "files": ["build/", "admin/", "io-package.json", "LICENSE"],
  "engines": { "node": ">=20.0.0" },
  "dependencies": {
    "@iobroker/adapter-core": "^3.4.3"
  },
  "devDependencies": {
    "@alcalzone/release-script": "^5.2.1",
    "@alcalzone/release-script-plugin-iobroker": "^5.2.0",
    "@alcalzone/release-script-plugin-license": "^5.2.2",
    "@iobroker/eslint-config": "^2.3.4",
    "@iobroker/testing": "^5.3.0",
    "@iobroker/types": "^7.2.2",
    "@tsconfig/node22": "^22.0.6",
    "@types/node": "^22.20.1",
    "typescript": "~6.0.3"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "watch": "tsc -p tsconfig.build.json --watch",
    "check": "tsc -p tsconfig.json --noEmit",
    "prepare": "npm run build",
    "lint": "eslint -c eslint.config.mjs",
    "test:package": "mocha test/packageFiles --exit",
    "test:integration": "mocha test/integrationAdapter --exit",
    "test": "npm run test:package",
    "release": "release-script --noPush -y",
    "release-patch": "release-script patch --yes",
    "release-minor": "release-script minor --yes",
    "release-major": "release-script major --yes",
    "update-packages": "npx npm-check-updates --upgrade"
  }
}
```

Wichtig:

- `"prepare": "npm run build"` — sorgt dafür, dass ein frischer Checkout nach `npm ci` direkt
  lauffähig ist (CI und Integrationstests verlassen sich darauf).
- `gulp`, `@iobroker/legacy-testing`, einzelne `eslint-plugin-*`/`prettier` → **raus**,
  `@iobroker/eslint-config` bringt das alles mit.
- `files` darf `main.js` / `lib/` nicht mehr enthalten, muss `build/` enthalten.
- Zusätzliche Laufzeit-Assets (z. B. `regascripts/` bei hm-rega) müssen in `files` bleiben.
- `@alcalzone/release-script-plugin-license` neu → dann in `.releaseconfig.json`
  `{ "plugins": ["iobroker", "license"] }`.
- `engines` mit der CI-Matrix konsistent halten (niedrigste getestete Node-Version).

### 3.2 `tsconfig.json` (nur Typprüfung)

```jsonc
// Root tsconfig to set the settings and power editor support for all TS files
{
    "compileOnSave": true,
    "extends": "@tsconfig/node22/tsconfig.json",
    "compilerOptions": {
        "noEmit": true,
        "allowJs": false,
        "skipLibCheck": true,
        "noEmitOnError": true,
        "outDir": "./build/",
        "rootDir": "./src/",
        "removeComments": false,
        "module": "Node16",
        "moduleResolution": "node16",
        "resolveJsonModule": true,
        "strict": true,
        "strictNullChecks": true,
        "strictPropertyInitialization": true,
        "target": "es2022",
        "sourceMap": true,
        "inlineSourceMap": false,
        "useUnknownInCatchVariables": false,
        "types": ["@iobroker/types", "@types/node"]
    },
    "include": ["src/**/*.ts"],
    "exclude": ["build/**", "node_modules/**", "admin/**"]
}
```

### 3.3 `tsconfig.build.json` (der eigentliche Build)

```jsonc
{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "noEmit": false,
        "declaration": false,
    },
    "exclude": ["src/**/*.test.ts"]
}
```

Output ist **CommonJS** (`module: Node16` und `package.json` ohne `"type": "module"`) — deshalb
funktioniert `require.main !== module` am Ende von `main.ts` weiterhin.

### 3.4 `eslint.config.mjs` + `prettier.config.mjs`

```js
// eslint.config.mjs
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                projectService: { allowDefaultProject: ['*.mjs'] },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        ignores: [
            'src-admin/**/*',
            'admin/**/*',
            'node_modules/**/*',
            'test/**/*',
            'build/**/*',
            'tasks.js',
            'tmp/**/*',
            'www/**/*',
            '.**/*',
        ],
    },
    {
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
];
```

```js
// prettier.config.mjs
import prettierConfig from '@iobroker/eslint-config/prettier.config.mjs';

export default prettierConfig;
```

`.eslintrc.json`, `.eslintignore`, `.prettierrc.json`, `.prettierignore` löschen.

### 3.5 `.gitignore`

Ergänzen:

```
build
*.tsbuildinfo
```

`package-lock.json` darf **nicht** ignoriert werden — die CI benutzt `npm ci`.

---

## 4. Etappe 2 — `gulpfile.js` → `tasks.ts`

**Erst entscheiden, ob überhaupt ein `tasks.ts` gebraucht wird.**

Der typische alte `gulpfile.js` enthält nur `adminWords2languages`, `adminLanguages2words`,
`translate`, `updatePackages`, `updateReadme`. Das sind alles Aufgaben rund um `admin/words.js`
und die Versionsnummer — nach der JsonConfig-Migration ist davon **nichts** mehr nötig.

| Fall                                                                            | Vorgehen                                                                          |
|---------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| Adapter hat **nur** JsonConfig, keine eigene React-/Vis-Oberfläche              | `gulpfile.js` **löschen**, kein `tasks.ts`. Build = `tsc`. (So macht es hm-rega.) |
| Adapter hat `src-admin/` (React), `src-widgets/`, Custom Components             | `tasks.ts` anlegen (siehe unten)                                                  |
| `gulpfile.js` macht adapterspezifische Dinge (Assets kopieren, Code generieren) | nur diese Tasks nach `tasks.ts` übernehmen                                        |

Ersatz für die weggefallenen Gulp-Tasks:

- `translate` → devDependency `@iobroker/adapter-dev` und Script
  `"translate": "translate-adapter -b admin/i18n/en.json"`.
- `updateReadme` / `updatePackages` → macht `@alcalzone/release-script` (`.releaseconfig.json`).
- `words2languages` / `languages2words` → entfällt zusammen mit `words.js`.

### `tasks.ts`-Vorlage (React-Admin, Muster `ioBroker.modbus`)

```ts
import { renameSync } from 'node:fs';
import { deleteFoldersRecursive, copyFiles, npmInstall, buildReact, patchHtmlFile } from '@iobroker/build-tools';

// ts-node hängt seine Bootstrap-Argumente an process.execArgv; child_process.fork() erbt sie und
// die Kinder (vite) starten mit cwd=src-admin, wo die relative tsconfig nicht existiert.
process.execArgv = [];

function clean(): void {
    deleteFoldersRecursive(`${__dirname}/admin`, ['<adapter>.png', 'jsonConfig.json', 'i18n']);
}

function copyAllFiles(): void {
    copyFiles(['src-admin/build/**/*'], 'admin/');
}

function patch(): Promise<void> {
    return patchHtmlFile(`${__dirname}/admin/index.html`).then(() => {
        renameSync(`${__dirname}/admin/index.html`, `${__dirname}/admin/index_m.html`);
    });
}

if (process.argv.includes('--0-clean')) {
    clean();
} else if (process.argv.includes('--1-npm')) {
    npmInstall(`${__dirname}/src-admin`).catch((e: unknown) => {
        console.error(`Cannot install npm: ${e as string}`);
        process.exit(1);
    });
} else if (process.argv.includes('--2-build')) {
    buildReact(`${__dirname}/src-admin/`, { rootDir: __dirname, vite: true }).catch((e: unknown) => {
        console.error(`Cannot build react: ${e as string}`);
        process.exit(1);
    });
} else if (process.argv.includes('--3-copy')) {
    copyAllFiles();
} else if (process.argv.includes('--4-patch')) {
    patch().catch((e: unknown) => {
        console.error(`Cannot patch: ${e as string}`);
        process.exit(1);
    });
} else {
    clean();
    npmInstall(`${__dirname}/src-admin`)
        .then(() => buildReact(`${__dirname}/src-admin/`, { rootDir: __dirname, vite: true }))
        .then(() => copyAllFiles())
        .then(() => patch())
        .catch((e: unknown) => {
            console.error(`Cannot build: ${e as string}`);
            process.exit(1);
        });
}
```

Dazu `tsconfig.tasks.json`:

```jsonc
{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "noEmit": true,
        "allowJs": false,
        "checkJs": false,
        "rootDir": ".",
        "module": "node16",
        "moduleResolution": "node16",
        "types": ["node"]
    },
    "ts-node": {
        "compilerOptions": { "module": "node16", "moduleResolution": "node16" },
        "transpileOnly": true
    },
    "include": ["tasks.ts"],
    "exclude": ["node_modules/**", "src/**", "src-admin/**", "test/**", "build/**"]
}
```

und die Scripts:

```jsonc
"build-backend": "tsc -p tsconfig.build.json",
"build":         "npm run build-backend && ts-node --project tsconfig.tasks.json tasks.ts",
"check-tasks":   "tsc -p tsconfig.tasks.json",
"0-clean": "ts-node --project tsconfig.tasks.json tasks.ts --0-clean",
"1-npm":   "ts-node --project tsconfig.tasks.json tasks.ts --1-npm",
"2-build": "ts-node --project tsconfig.tasks.json tasks.ts --2-build",
"3-copy":  "ts-node --project tsconfig.tasks.json tasks.ts --3-copy",
"4-patch": "ts-node --project tsconfig.tasks.json tasks.ts --4-patch"
```

devDependencies dafür: `@iobroker/build-tools`, `ts-node`. Alternative: `tsx`, dann
`"build": "tsx tasks.ts"` ganz ohne `tsconfig.tasks.json` — siehe `ioBroker.scheduler`.

`@iobroker/build-tools` bietet u. a.: `deleteFoldersRecursive`, `copyFiles`,
`copyFolderRecursiveSync`, `readDirRecursive`, `collectFiles`, `npmInstall`, `tsc`,
`buildReact({ vite, craco, tsc, rootDir, exec, ramSize })`, `patchHtmlFile`,
`copyWidgetsFiles`, `ignoreWidgetFiles`.

Die Einzelschritt-Scripts (`0-clean` … `4-patch`) sind kein Luxus: beim Debuggen eines
fehlgeschlagenen Admin-Builds will man genau eine Stufe wiederholen können.

---

## 5. Etappe 3 — HTML-Admin → JsonConfig

### 5.1 Quellen auslesen

```bash
grep -n 'class="value"' admin/index_m.html      # id -> native.<id>
grep -n 'id="' admin/index_m.html
cat admin/words.js                              # Übersetzungen
node -p "JSON.stringify(require('./io-package.json').native,null,2)"
```

Jedes Eingabefeld in `index_m.html` mit `class="value"` und `id="xyz"` entspricht `native.xyz`.
Die Key-Menge in `jsonConfig.json` muss deckungsgleich mit `io-package.json` → `native` sein.

### 5.2 `admin/jsonConfig.json` schreiben

Grundgerüst (ein Panel; bei vielen Optionen `"type": "tabs"` mit Panels darin):

```jsonc
{
    "i18n": true,
    "type": "panel",
    "items": {
        "_logo":  { "type": "staticImage", "src": "<adapter>.png", "style": { "width": "64px" }, "sm": 12, "md": 2, "lg": 1 },
        "host":   { "type": "text",     "label": "IP/Hostname", "sm": 12, "md": 6, "lg": 4 },
        "port":   { "type": "number",   "label": "Port", "min": 1, "max": 65535, "sm": 12, "md": 2 },
        "mode":   { "type": "select",   "label": "Type", "noTranslation": true,
                    "options": [{ "value": "a", "label": "A" }] },
        "user":   { "type": "text",     "label": "User" },
        "pass":   { "type": "password", "label": "Password", "visible": "data.user !== ''" },
        "active": { "type": "checkbox", "label": "Enabled", "newLine": true, "sm": 12 }
    }
}
```

Umsetzungstabelle:

| HTML                                  | JsonConfig `type`                                                        |
|---------------------------------------|--------------------------------------------------------------------------|
| `<input type="text">`                 | `text`                                                                   |
| `<input type="number">`               | `number` (+ `min` / `max`)                                               |
| `<input type="password">`             | `password` (+ `"encrypted": true`, falls die Native so gespeichert wird) |
| `<input type="checkbox">`             | `checkbox`                                                               |
| `<select>`                            | `select` mit `options: [{ value, label }]`                               |
| per `sendTo` dynamisch gefüllte Liste | `selectSendTo` / `autocompleteSendTo` mit `command`                      |
| `<table>` mit Add/Delete              | `table` mit `items: [...]`                                               |
| Überschrift `<h4>`                    | `header` (`text`, `size`)                                                |
| Logo `<img>`                          | `staticImage`                                                            |

Nützliche Attribute: `newLine`, `sm`/`md`/`lg` (12-Spalten-Grid), `hidden`, `disabled`,
`visible` (JS-Ausdruck über `data`), `help`, `validator` + `validatorErrorText` +
`validatorNoSaveOnError`, `default`, `noTranslation`, `alsoDependsOn`, `onChange.calculateFunc`.

Alle verfügbaren Controls mit Beispiel:
`C:\pWork\ioBroker.jsonconfig-demo\admin\jsonConfig.json5`.
Formales Schema: `C:\pWork\ioBroker.admin\packages\jsonConfig\schemas\jsonConfig.json`.

### 5.3 Dynamische Felder → `onMessage`

`selectSendTo` / `autocompleteSendTo` rufen die **laufende Instanz** per `sendTo` auf. Der Handler
muss in `onMessage()` **vor** einer eventuellen Legacy-Fallback-Behandlung stehen:

```ts
private onMessage(obj: ioBroker.Message): void {
    if (obj?.command === 'listUart' && obj.callback) {
        void this.listSerialPorts().then(ports => this.sendTo(obj.from, obj.command, ports, obj.callback));
        return;
    }
    // ... alte Kommandos unverändert weiterbehandeln
}
```

Rückgabeformat für `selectSendTo`: `Array<{ value: string; label: string }>`.
`freeSolo: true` bei `autocompleteSendTo` erlaubt weiterhin freie Eingabe — wichtig, wenn die
Instanz beim Konfigurieren noch gar nicht läuft.

### 5.4 i18n umstellen (Ordner → flach)

Neu ist eine flache Datei pro Sprache: `admin/i18n/de.json` statt `admin/i18n/de/translations.json`.

```bash
cd admin/i18n
for l in en de ru pt nl fr it es pl zh-cn; do
  [ -f "$l/translations.json" ] && git mv "$l/translations.json" "$l.json" && rmdir "$l" 2>/dev/null
done
```

Danach:

- Keys sind die **englischen Labels aus `jsonConfig.json`**, nicht mehr die alten `words.js`-Keys.
- Nicht mehr benutzte Keys entfernen, fehlende ergänzen; `en.json` ist die Referenz.
- Übersetzen: `npx translate-adapter -b admin/i18n/en.json` (devDependency
  `@iobroker/adapter-dev`) — oder Weblate machen lassen.
- `"i18n": true` in `jsonConfig.json` sorgt dafür, dass diese Dateien benutzt werden.

### 5.5 Aufräumen

```bash
git rm admin/index.html admin/index_m.html admin/words.js
git rm gulpfile.js                      # falls kein tasks.ts nötig ist
git rm lib/gulptools.js lib/tools.js    # nur wenn ausschließlich vom gulpfile benutzt – vorher prüfen!
```

`admin/<adapter>.png` und alle in `jsonConfig.json` referenzierten Bilder bleiben.

---

## 6. Etappe 4 — JS → TypeScript in `src/`

### 6.1 Dateien verschieben

```bash
mkdir -p src/lib
git mv main.js src/main.ts
git mv lib/foo.js src/lib/foo.ts
```

Sinnvolle Aufteilung (Muster hm-rega):

| Datei                         | Inhalt                                                    |
|-------------------------------|-----------------------------------------------------------|
| `src/main.ts`                 | die Adapterklasse                                         |
| `src/lib/types.ts`            | alle Interfaces für Fremddaten (Protokoll, API-Antworten) |
| `src/lib/<transport>.ts`      | Kommunikation mit Gerät/Dienst als eigene Klasse          |
| `src/lib/utils.ts`            | Hilfsfunktionen, Konstanten (`FORBIDDEN_CHARS`, …)        |
| `src/lib/adapter-config.d.ts` | Typ von `this.config`                                     |

### 6.2 `src/lib/adapter-config.d.ts`

Muss **1:1** zu `io-package.json` → `native` und zu `admin/jsonConfig.json` passen — das
generiert nichts, das ist Handarbeit und die häufigste Fehlerquelle.

```ts
// Augments the globally declared ioBroker types with everything this adapter adds.
// Keep in sync with `native` in io-package.json and with admin/jsonConfig.json.
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Serieller Port, z. B. COM3 oder /dev/ttyACM0 */
            serialport: string;
            baudrate: number;
            mode: 'SlowRF' | 'MORITZ' | 'AskSin';
            experimental: boolean;
        }

        /** nur falls io-package.json `notifications` deklariert */
        interface NotificationScopes {
            '<adapter>': 'scope1' | 'scope2';
        }
    }
}

export {}; // nötig, damit die Datei als Modul gilt
```

### 6.3 Adapterklasse statt Modul-Globals

Alt:

```js
let adapter;
let connectTimeout;
function startAdapter(options) {
    adapter = new utils.Adapter(Object.assign(options || {}, { name: adapterName }));
    adapter.on('stateChange', (id, state) => { /* ... */ });
    adapter.on('ready', () => main());
    return adapter;
}
```

Neu:

```ts
import * as utils from '@iobroker/adapter-core';

class MyAdapter extends utils.Adapter {
    private connectTimeout: ioBroker.Timeout | null = null;
    private readonly objects: Record<string, ioBroker.Object> = {};

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'myadapter' });

        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('message', obj => this.onMessage(obj));
        this.on('unload', callback => this.onUnload(callback));
    }

    private async onReady(): Promise<void> {
        /* ... */
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        /* ... */
    }

    private onUnload(callback: () => void): void {
        try {
            // Verbindungen schließen; Timer von this.setTimeout/setInterval räumt adapter-core selbst auf
        } catch {
            // ignore
        }
        callback();
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new MyAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new MyAdapter())();
}
```

Regeln beim Übersetzen:

- **Alle Modul-Globals werden Instanzfelder** (`private xyz: T | null = null`). Kein `let` auf
  Modulebene außer echten Konstanten (`const` + `UPPER_CASE`).
- **Timer:** immer `this.setTimeout` / `this.setInterval` / `this.clearTimeout` /
  `this.clearInterval` von adapter-core benutzen, nie die globalen. Typen sind
  `ioBroker.Timeout | null` bzw. `ioBroker.Interval | null`. Nur so werden sie beim Unload
  automatisch gestoppt (erfordert js-controller ≥ 5.0.19).
- **Callbacks → `async` / `await`.** adapter-core 3 liefert Promises, wenn kein Callback übergeben
  wird: `await this.getObject(id)`. In `void`-Kontexten `void this.doSomething();` schreiben,
  damit `no-floating-promises` zufrieden ist.
- **Imports:** `require('path')` → `import { join } from 'node:path'`, `require('fs')` →
  `import { readFileSync } from 'node:fs'`. JSON-Imports gehen dank `resolveJsonModule`.
- **Kein `any`.** Fremde Datenstrukturen als Interface in `src/lib/types.ts`. Wo eine Struktur
  wirklich unbekannt ist: `unknown` + Type-Guard.
- **Module ohne Typings** (z. B. `cul`): entweder `@types/<modul>` installieren oder
  `src/types/<modul>.d.ts` mit `declare module 'cul' { … }` anlegen und minimal, aber ehrlich
  typisieren.
- **`catch (e)`** ist wegen `useUnknownInCatchVariables: false` als `any` typisiert — trotzdem
  `(e as Error).message` schreiben.
- `this.config.x` ist jetzt getypt. Alte Defensivchecks wie
  `config.experimental === true || config.experimental === 'true'` zeigen, dass der Wert früher als
  String ankam: entweder beibehalten oder bewusst normalisieren und im Changelog erwähnen.
- Objektdefinitionen als `ioBroker.SettableObject` / `ioBroker.StateObject` typisieren, damit
  falsche `common.type` / `role`-Werte auffallen.

### 6.4 ESM-Dependencies aus dem CJS-Build laden

Der Adapter-Build ist CommonJS (`module: Node16`, kein `"type": "module"` in der `package.json`) —
das ist Pflicht, weil der Compact-Mode-Export am Dateiende `module.exports` braucht. Immer mehr
npm-Pakete sind aber inzwischen **ESM-only** (`"type": "module"` in ihrer `package.json`), und
`require()` scheitert daran zur Laufzeit.

Erkennen, bevor man anfängt:

```bash
npm view <paket> type main exports        # "type = module"  =>  ESM-only
```

Lösung — der Wert kommt per **dynamischem `import()`**, der Typ per **type-only Import mit
`resolution-mode`**:

```ts
// Typen: wird beim Kompilieren gelöscht, braucht aber den Hinweis, dass das Ziel ESM ist
import type { Cul as CulDevice } from 'cul' with { 'resolution-mode': 'import' };

class MyAdapter extends utils.Adapter {
    private cul: CulDevice | null = null;

    private async connect(): Promise<void> {
        // `cul` ist ESM-only und kann aus diesem CommonJS-Build nicht require't werden
        const { default: Cul } = await import('cul');
        this.cul = new Cul(options);
    }
}
```

Das funktioniert nur, weil TypeScript `import()` bei `module: Node16`/`NodeNext` **unverändert
stehen lässt**, statt es zu einem `require()` herunterzuschreiben. Nach dem ersten Build einmal
kontrollieren — das ist eine 10-Sekunden-Prüfung, die viel Sucherei spart:

```bash
grep -n "import(" build/main.js         # muss noch da sein, kein require()
node -e "require('./build/main.js')"    # lädt das Modul wirklich?
```

Fallstricke:

- **Ohne `with { 'resolution-mode': 'import' }`** meldet `tsc` `TS1541: Type-only import of an
  ECMAScript module from a CommonJS module must have a 'resolution-mode' attribute`.
- **`typeof import('paket').Klasse`** als Feldtyp verbietet die ESLint-Regel
  `@typescript-eslint/consistent-type-imports`. Stattdessen `import type { Klasse } from 'paket';`
  und dann `private feld: typeof Klasse | null = null;`.
- **Modulnamen nicht doppelt vergeben:** `import type { Cul }` und lokal
  `const { default: Cul } = await import('cul')` beißen sich. Den Typ umbenennen
  (`import type { Cul as CulDevice }`).
- **CJS-Pakete bleiben normale Imports.** `serialport` z. B. hat kein `"type": "module"` und wird
  weiterhin statisch importiert. Nur ein dynamischer Import, wenn das Paket ESM ist oder — wie bei
  nativen Modulen — der Ladefehler abgefangen werden soll.
- Die `module`-Einstellung danach **nicht mehr anfassen**. Ein Wechsel auf `commonjs` schreibt die
  `import()`-Aufrufe still zu `require()` um, und der Adapter stirbt erst zur Laufzeit mit
  `ERR_REQUIRE_ESM`.

### 6.5 Iterativ compilieren

```bash
npm run build 2>&1 | head -50
```

Fehler von oben nach unten abarbeiten. Erst wenn `npm run build` sauber ist:

```bash
npm run check
npx eslint -c eslint.config.mjs --fix src
npm run lint
```

---

## 7. Etappe 5 — `io-package.json`

```jsonc
"common": {
    // "title": "..."            <- entfernen, titleLang reicht
    "titleLang": { "en": "...", "de": "..." },
    // "materialize": true       <- entfernen
    "adminUI": { "config": "json" },
    "compact": true,
    "dependencies": [
        { "js-controller": ">=6.0.11" }
    ],
    "globalDependencies": [
        { "admin": ">=7.0.0" }
    ]
}
```

- `native` vollständig gegen `jsonConfig.json` **und** `adapter-config.d.ts` abgleichen; fehlende
  Defaults ergänzen (neue Felder ohne Default sind bei Bestandsinstanzen `undefined`).
- `common.news` nicht von Hand anfassen — das macht das release-script.
- `common.messagebox: true` muss gesetzt bleiben, wenn `onMessage` benutzt wird.
- Bietet der Adapter eine Message-API an: `common.supportedMessages` prüfen.

---

## 8. Etappe 6 — Tests und CI

### 8.1 Tests auf `@iobroker/testing` v5

Alte `test/lib/setup.js`, `test/mocha.setup.js`, `test/testAdapter.js` (legacy-testing) löschen,
stattdessen:

```js
// test/packageFiles.js
'use strict';
const path = require('node:path');
const { tests } = require('@iobroker/testing');

tests.packageFiles(path.join(__dirname, '..'));
```

```js
// test/integrationAdapter.js
'use strict';
const path = require('node:path');
const { tests } = require('@iobroker/testing');

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test sendTo()', getHarness => {
            it('Should work', () =>
                new Promise(resolve => {
                    const harness = getHarness();
                    harness.startAdapterAndWait().then(() => {
                        harness.sendTo('<adapter>.0', 'test', 'message', resp => {
                            console.dir(resp);
                            resolve();
                        });
                    });
                }));
        });
    },
});
```

Der Integrationstest bricht ab, wenn auf der Maschine **schon ein js-controller läuft**
("JS-Controller is already running!") — das ist kein Fehler des Refactorings.

### 8.2 GitHub Action

`.github/workflows/test-and-release.yml` aus dem Referenzprojekt übernehmen. Entscheidend:

```yaml
      - uses: ioBroker/testing-action-adapter@v1
        with:
          node-version: ${{ matrix.node-version }}
          os: ${{ matrix.os }}
          build: true          # <- ohne das läuft der TS-Build in der CI nicht
```

Im Deploy-Job (`ioBroker/testing-action-deploy@v1`) ebenfalls `build: true`.
Node-Matrix auf aktuellen Stand bringen (`[22.x, 24.x, 26.x]`, `check-and-lint` auf `24.x`) und
mit `engines` in `package.json` konsistent halten.

---

## 9. Etappe 7 — Doku und Release

- `README.md`: Changelog-Eintrag unter dem `### **WORK IN PROGRESS**`-Platzhalter ergänzen, z. B.
  `- (bluefox) The adapter was refactored to TypeScript and JsonConfig`.
  Werden dabei Mindestversionen (Node, js-controller, admin) angehoben: **explizit erwähnen** —
  das ist ein Breaking Change und damit ein Major-Release.
- `LICENSE`-Jahr aktualisieren (macht das `license`-Plugin des release-scripts).
- `CLAUDE.md` schreiben/aktualisieren: Was ist der Adapter, welche Commands, Architektur, wo werden
  States geschrieben, Konventionen, Release-Flow.
  Vorbild: `C:\pWork\ioBroker.hm-rega\CLAUDE.md`.
- Release erst nach grünem Build: `npm run release-major` (bzw. `-minor` / `-patch`).

---

## 10. Abschluss-Checkliste

```bash
rm -rf node_modules build && npm ci     # der prepare-Hook muss build/ erzeugen
npm run build
npm run check
npm run lint
npm run test:package
npm run test:integration                # nur wenn kein js-controller läuft
git status                              # build/ darf nicht auftauchen
```

Manuell prüfen:

- [ ] `main.js` und `lib/*.js` sind weg, `package.json.main` zeigt auf `build/main.js`
- [ ] `files` enthält `build/` und alle Laufzeit-Assets, aber nicht `src/`
- [ ] `gulpfile.js` gelöscht (oder bewusst durch `tasks.ts` ersetzt), `gulp` aus devDependencies raus
- [ ] `admin/index*.html` und `admin/words.js` gelöscht
- [ ] `admin/jsonConfig.json` deckt **alle** `native`-Keys ab, keine überzähligen
- [ ] `src/lib/adapter-config.d.ts` == `native` == `jsonConfig.json`
- [ ] `common.adminUI.config = "json"`, `materialize` entfernt
- [ ] `admin/i18n/<lang>.json` flach, alle 10 Sprachen, `en.json` vollständig
- [ ] `main.ts` ist eine Klasse `extends utils.Adapter`, keine `startAdapter()`-Funktion mit
      Modul-Globals; Handler sind private Methoden (`onReady`, `onStateChange`, `onMessage`, `onUnload`)
- [ ] keine globalen `setTimeout` / `setInterval` mehr im Backend
- [ ] `onUnload` schließt alles, was `onReady` geöffnet hat
- [ ] Compact-Mode-Export am Ende von `main.ts` vorhanden
- [ ] Adapter in einer echten Installation gestartet, Konfigdialog geöffnet und gespeichert

---

## 11. Stolpersteine

- **`build/` fehlt in der CI** → `build: true` in der GitHub-Action oder das `prepare`-Script vergessen.
- **`__dirname` zeigt jetzt auf `build/`.** Jeder Pfad auf Assets außerhalb von `build/` braucht ein
  `..`: `join(__dirname, '..', 'regascripts')`. Alle `readFileSync` / `readdirSync`-Stellen durchgehen!
- **ESM-only-Dependency im CJS-Build**: `require()` wirft `ERR_REQUIRE_ESM`. Per `await import()`
  laden und den Typ mit `with { 'resolution-mode': 'import' }` holen, siehe Abschnitt 6.4.
- **`require('./package.json')`** in `src/` löst nach `build/package.json` auf → auf
  `join(__dirname, '..', 'package.json')` umstellen oder den Adapternamen als Konstante schreiben.
- **Verschwundene Config-Felder:** existierte ein Feld im HTML-Admin, fehlt aber in
  `jsonConfig.json`, wird es beim ersten Speichern aus `native` gelöscht — Instanzen verlieren still
  ihre Einstellung. Deshalb die Key-Listen dreifach abgleichen.
- **Passwörter:** `"type": "password"` + `"encrypted": true` nur so beibehalten, wie es vorher war.
  Ein Wechsel auf `encryptedNative` entwertet die gespeicherten Zugangsdaten aller Bestandsinstanzen.
- **`sendTo`-Kommandonamen** dürfen sich nicht ändern, wenn der Adapter eine dokumentierte
  Message-API hat — User-Skripte rufen sie auf.
- **Prettier vs. ESLint:** nur `npx eslint -c eslint.config.mjs --fix` benutzen. Ein separat
  aufgerufenes Prettier mit anderer Config erzeugt Endlos-Diffs.
- **Weblate:** Übersetzungen kommen als PRs von `ioBrokerTranslator`. Vor dem Umbenennen der
  i18n-Dateien offene Weblate-PRs mergen, sonst gibt es Konflikte in Dateien, die es nicht mehr gibt.
