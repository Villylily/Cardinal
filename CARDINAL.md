# Building apps for Cardinal

Cardinal is the small Node.js app manager in this project. It starts and stops apps, keeps app data separate from app source, and gives apps a local API for settings and notifications. This guide covers setup, adding apps, Cardinal DB, the APIs, backups, and troubleshooting.

## License

The [license notice](CARDINAL-LICENSE.md) applies to both Cardinal and Cardinal DB source in this export. The covered source uses the PolyForm Noncommercial License 1.0.0; the notice also explains third-party attributions and assets that are not included. Separately licensed apps, packages, and assets keep their own terms. Read the full license terms at the URL in the notice.

## Requirements and folders

- Node.js 20 or newer.
- App source goes in `apps\<app-id>`; use a lowercase ID with letters, numbers, `_`, or `-` (up to 48 characters).
- Cardinal's managed app data is separate from the source: `data\cardinal\apps\<app-id>` by default.
- Do not put passwords, API keys, live databases, or other private files in source control.

Cardinal's app manager discovers each app by its `cardinal.app.json` file. The app ID comes from the folder name.

## Install and start Cardinal

1. Install Node.js 20 or newer.
2. From the project root, run `npm install`.
3. Run `start-cardinal.bat` or `node cardinal.js`.
4. On first startup, Cardinal creates `data\cardinal\config\cardinal.config.json` using the example template, then exits so you can set a password.
5. Edit that private config with a non-empty username and password, then start Cardinal again.
6. Open `https://127.0.0.1:6868/control` in a browser and sign in. The first run creates a self-signed local certificate, so the browser will show a certificate warning until you explicitly trust it.

The default listen address is loopback-only. Cardinal currently rejects non-loopback listen hosts. Set `CARDINAL_HOME` before starting Cardinal to move all Cardinal runtime data to another folder. Keep that folder private and backed up; it contains passwords, app configs, databases, logs, certificate files, and other runtime state.

The example at `cardinal components\core\cardinal.config.example.json` is only a template; it must not contain real credentials. Cardinal does not need its runtime config committed to source control.

## What goes where

| Path | What it is |
|---|---|
| `cardinal.js` | Starts the Cardinal server. |
| `cardinal components\core` | App manager, control panel server, settings, and local API wiring. |
| `cardinal components\control-plane` | Browser files for the Cardinal control panel. |
| `apis\app-api` | Private API used by running apps. |
| `libs\cardinal-db` | JSON database and optional message-history helper. |
| `libs\cardinal-client` | Client for the local app API. |
| `libs\app-runtime` | Helpers for resolving app data and config paths. |
| `apps\<app-id>` | App source and its manifest. |
| `data\cardinal\config` | Cardinal's private settings and app auto-start overrides. |
| `data\cardinal\apps\<app-id>\config` | That app's private config. |
| `data\cardinal\apps\<app-id>\database` | That app's Cardinal DB collections. |
| `data\cardinal\apps\<app-id>\logs` | That app's log file. |

If `CARDINAL_HOME` is set, the paths under `data\cardinal` move under that folder instead. Do not copy the `data` directory into a public source repository.

## Add a small app

Create these files:

```text
apps\
  hello-cardinal\
    cardinal.app.json
    app.js
    config.example.json
```

`apps\hello-cardinal\cardinal.app.json`:

```json
{
  "name": "Hello Cardinal",
  "description": "A small example app.",
  "entrypoint": "app.js",
  "workingDirectory": ".",
  "configSeed": "config.example.json",
  "autoStart": false
}
```

`name`, `description`, and `entrypoint` are required. `workingDirectory` is relative to the app folder and defaults to `"."`. The entrypoint and working directory must stay inside Cardinal's installation folder.

`configSeed` is optional. Cardinal copies it to the app's private config the first time the app starts; changing the seed later does not overwrite that private config. Keep secrets out of the seed and enter them in the running app's config instead.

For optional initial data or environment variables, add fields like these to the manifest:

```json
{
  "dataSeeds": [
    { "source": "seed/defaults.json", "target": "defaults.json" }
  ],
  "environment": {
    "APP_PORT": "8888"
  }
}
```

`dataSeeds` is a list of source/target file pairs. Each source path is resolved from the app folder and must stay inside Cardinal's installation. Cardinal copies an existing source file into that app's private data folder the first time the target is needed; it will not overwrite existing app data. `environment` is a map of extra environment variables for the app. Do not put secrets in it because the manifest is source code.

`autoStart` controls whether the app starts with Cardinal. You can also change it in the Cardinal control panel.

Manifest fields in full:

| Field | Required | Meaning |
|---|---|---|
| `name` | No | Display name; falls back to the app ID. |
| `description` | No | Short description shown in Cardinal. |
| `entrypoint` | Yes | JavaScript file Cardinal runs with Node. |
| `workingDirectory` | Yes | Directory for the app process, relative to the app folder. Use `"."` for the app folder. |
| `configSeed` | No | JSON template copied to the private config the first time, if present. |
| `dataSeeds` | No | List of `{ "source": "...", "target": "..." }` file copies into persistent app data. |
| `environment` | No | Extra environment variables for the child process. |
| `autoStart` | No | `true` to start the app automatically with Cardinal. |

The `entrypoint` and `workingDirectory` must stay inside Cardinal's installation. An app is discovered only at Cardinal startup; restart Cardinal after adding or removing app folders. App IDs must start with a lowercase letter or number and contain only lowercase letters, numbers, `_`, or `-`.

### App dependencies

If your app uses npm packages, add an `apps\<app-id>\package.json` and list the packages under `dependencies`. This project uses npm workspaces for `apps/*`; after adding or changing app dependencies, run `npm install` from the project root. Cardinal starts the app's entrypoint directly with Node, so it does not run the app's `start` script for you. The source export includes the same workspace setting and an empty apps folder, ready for new app packages.

`apps\hello-cardinal\config.example.json`:

```json
{
  "greeting": "Hello"
}
```

`apps\hello-cardinal\app.js`:

```js
const { CardinalDB } = require('../../libs/cardinal-db/cardinal-db');
const { createCardinalClient } = require('../../libs/cardinal-client/cardinal-client');

async function main() {
    const database = new CardinalDB();
    const cardinal = createCardinalClient();
    const app = await cardinal.getApp();
    const config = await cardinal.getConfig();

    await database.update('visits', 'total', count => (count || 0) + 1);
    const visits = await database.get('visits', 'total');

    await cardinal.notify({
        title: `${app.name} started`,
        message: `${config.greeting || 'Hello'}! This app has started ${visits} time(s).`,
        level: 'success'
    });

    console.log(`${app.name} is running.`);
}

main().catch(error => {
    console.error('Hello Cardinal could not start:', error);
    process.exitCode = 1;
});
```

The app's first `database.update` initializes the `total` value if it is missing. Cardinal DB values must be JSON-serializable. Database methods are asynchronous, so use `await` and handle errors rather than treating a failed write as success.

Apps run as child Node processes under the same Windows account as Cardinal and inherit Cardinal's process environment, plus the app-specific variables listed in the manifest. They are not an operating-system security sandbox: only install and run app code you trust, and avoid launching Cardinal from an environment containing secrets that an app should not access.

## Cardinal DB

An app's default database folder is `data\cardinal\apps\<app-id>\database`. Cardinal sets `CARDINAL_APP_DATA_DIR` for managed apps, and `new CardinalDB()` uses its `database` subfolder. For a standalone script or test, pass an explicit directory:

```js
const database = new CardinalDB({ directory: 'C:\\my-app-data\\database' });
```

Collections are separate JSON files. Collection names use lowercase letters, numbers, `_`, or `-` and are at most 64 characters. Keys are at most 256 characters. Common methods:

```js
await database.set('players', 'player-123', { name: 'Alex', visits: 1 });
const player = await database.get('players', 'player-123');
const exists = await database.has('players', 'player-123');
const players = await database.list('players', { limit: 100 });
const total = await database.count('players');

await database.update('players', 'player-123', current => ({
    ...current,
    visits: (current?.visits || 0) + 1
}));
```

### Cardinal DB method list

Every method returns a promise:

| Method | What it does |
|---|---|
| `get(collection, key)` | Get a copied value, or `undefined` if the key is missing. |
| `has(collection, key)` | Check whether a key exists. |
| `list(collection, { limit, after })` | Read records as `{ key, value }` entries. `limit` is 1-1000; `after` is an existing key for cursor paging. |
| `find(collection, predicate, { limit, after })` | Filter records using `predicate(value, key)`; supports the same paging options. |
| `findOne(collection, predicate)` | Return the first matching `{ key, value }`, or `undefined`. |
| `getMany(collection, keys)` | Read a list of keys in the same order requested. Missing values are `undefined`. |
| `set(collection, key, value)` | Save one JSON value. |
| `setMany(collection, entries)` | Save `{ key, value }` entries together; returns the number of entries written. |
| `delete(collection, key)` | Delete one key; returns whether it existed. |
| `deleteMany(collection, keys)` | Delete keys; returns the number actually removed. |
| `count(collection)` | Count records in the collection. |
| `update(collection, key, updater)` | Pass the copied current value to `updater`; return a value to save, or `undefined` to delete. |
| `updateWhere(collection, predicate, updater, { limit })` | Update matching records together; `limit` is optional and capped at 1000. |
| `transaction(collection, callback)` | Make several changes to a collection in one atomic write. |
| `clear(collection)` | Remove all records in a collection. |
| `listCollections()` | List collection names. |
| `exportCollection(collection)` | Export one versioned collection document. |
| `exportAll()` | Export all collections as a database backup. |
| `importCollection(collection, document, { replace })` | Merge or replace records from a supported collection export. |
| `deleteCollection(collection)` | Remove a collection file. |
| `doctor({ repair })` | Check DB files, or attempt supported repairs when `repair: true`. |
| `close()` | Wait for pending operations to finish. |

`list` and `find` return records in the collection's stored order; use `after` to continue from a key you received. Values are JSON-cloned on the way in and out, so changing a returned object does not change the stored record. An `update` callback returning `undefined` deletes that key; do not use that return value to store JSON `null`.

Use `transaction` when several changes to one collection must succeed together:

```js
await database.transaction('settings', transaction => {
    transaction.set('theme', 'dark');
    transaction.set('language', 'en');
});
```

The transaction object has `get`, `has`, `list`, `set`, `delete`, and `update` methods. Use only those supplied methods inside the callback; do not call or `await` regular database methods from inside it. Cardinal DB serializes changes and writes them atomically. It is a local JSON store, not a replacement for a remote database or a place to keep app passwords.

For backups, `await database.exportAll()` returns a JSON backup; save it somewhere outside the app's live database directory. `importCollection(name, document)` merges records, and `importCollection(name, document, { replace: true })` replaces that collection's records. Imports are limited to 16 MB and whole-database backups to 64 MB. `await database.doctor()` checks the files without changing them; `await database.doctor({ repair: true })` attempts supported repairs and keeps recoverable originals in the `recovery` folder. Unsupported formats and data that cannot be safely repaired are reported, not guessed at. Export a backup before repair when possible. The control panel also has database export and doctor actions for each app.

`CardinalMessageStore` is optional; use it only if the app needs paged message history. See [the Cardinal DB guide](libs/cardinal-db/README.md).

## App-to-Cardinal API

While an app is starting or running, Cardinal gives it these environment variables:

- `CARDINAL_HOME`: Cardinal's data folder.
- `CARDINAL_APP_ID`: the app's ID.
- `CARDINAL_APP_DATA_DIR`: the app's persistent data folder.
- `CARDINAL_APP_CONFIG`: the app's private config file.
- `CARDINAL_API_URL` and `CARDINAL_API_TOKEN`: the private, local API connection.

Use `createCardinalClient()` from `libs\cardinal-client\cardinal-client.js`; it reads the API URL and token from the environment. The client can identify the app, read or save its config, and send a notification:

```js
const { createCardinalClient } = require('../../libs/cardinal-client/cardinal-client');

const cardinal = createCardinalClient();
const app = await cardinal.getApp();
const config = await cardinal.getConfig();
await cardinal.updateConfig({ ...config, enabled: true });
await cardinal.notify({
    title: `${app.name} needs attention`,
    message: 'A background task failed.',
    level: 'error'
});
```

Saving config does not change the already-running app's in-memory settings; restart the app to load the new values. Notifications accept `info`, `success`, `warning`, or `error`.

The app API is only available on the local computer and uses a separate token for each running app. Do not copy the token into a config file, print it in logs, or expose it to a browser. The browser-facing management API is under `/control/api/v1` and requires an authenticated Cardinal session.

### App API reference

The client handles URLs, JSON, authentication, and errors. If you need to call the local API directly, send the `Authorization: Bearer <token>` header and JSON request bodies:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/app` | Return the connected app's ID, name, and description. |
| `GET` | `/v1/app/config` | Read the app's private config object. |
| `PUT` | `/v1/app/config` | Save `{ "config": { ... } }`; the app must reload config after restarting. |
| `POST` | `/v1/notifications` | Send `{ "title": "...", "message": "...", "level": "info" }`. Level may be `info`, `success`, `warning`, or `error`. |

These routes are only reachable through Cardinal's loopback app server. Requests require a token issued to an app that is starting or running. Notifications need a 1-100 character title and a 1-2000 character message. Invalid JSON or oversized bodies are errors; check the response and do not assume a failed request succeeded.

### Browser management API

The authenticated control API base is `/control/api/v1`. It uses the logged-in Cardinal browser session; do not give an app's API token to a browser or another service.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | List the API routes. |
| `GET` | `/apps` | List discovered apps and status. |
| `GET` | `/storage` | Show app storage and DB usage totals. |
| `GET` | `/apps/:id` | Read one app's status. |
| `POST` | `/apps/:id/actions/start`, `/stop`, `/restart` | Control an app process. |
| `PUT` | `/apps/:id/auto-start` | Set `{ "enabled": true }` or `false`. |
| `GET` | `/apps/:id/database/export` | Download a backup of the app DB. |
| `POST` | `/apps/:id/database/doctor` | Check DB files; send `{ "repair": true }` to attempt repair. |
| `GET` / `PUT` | `/apps/:id/config` | Read or save `{ "config": { ... } }`. |
| `GET` | `/apps/:id/logs` | Read recent app logs. |
| `GET` / `PUT` | `/settings` | Read or change Cardinal host, port, or login. |
| `GET` | `/notifications` | List app notifications. |
| `DELETE` | `/notifications/:id` | Dismiss a notification. |

Config or login changes that affect a running process/server may require restart or reauthentication; responses indicate this where applicable. Cardinal's settings endpoint only accepts loopback addresses.

## Manage and troubleshoot apps

In the Cardinal control panel you can start, stop, and restart apps; change app config and auto-start; read recent logs; export an app's database; and run the database doctor. Cardinal also stops managed apps when Cardinal itself shuts down.

If an app does not appear, check that its folder is directly inside `apps`, the folder name is a valid ID, and its manifest is valid JSON with an existing entrypoint. If it starts and exits, check the app's logs and confirm its dependencies are installed. Cardinal does not install an app's extra npm dependencies for you. Config and database files stay under `data\cardinal\apps`; removing or replacing app source does not back them up for you.

Common checks:

- **Cardinal exits after first launch:** expected when it has just created the initial config. Set a username and password in the private config and start it again.
- **The browser cannot connect:** confirm Cardinal is running and open the configured loopback host and port. The default is `https://127.0.0.1:6868/control`.
- **Certificate warning:** expected for the generated self-signed certificate. Only trust it if this is your own local Cardinal instance.
- **App does not show up:** verify its folder is directly in `apps`, its ID matches the allowed format, its manifest is valid JSON, and `entrypoint` exists. Restart Cardinal to rediscover new apps.
- **App starts then stops:** read its Cardinal logs; check that required modules exist and startup errors are handled.
- **Config edit does not affect the running app:** restart the app or make the app reload its config itself.
- **A DB read is empty:** check the app ID and collection/key. Cardinal DB data is isolated by app and isn't stored in the source folder.
- **DB doctor reports a problem:** export a backup first. Repair only supported cases; inspect the report and recovery copy before replacing anything manually.
- **An app API request returns 401:** use the API client inside a managed, running app; do not use an expired token or a token from another app.

## Development and tests

From the project root, install the project's dependencies with `npm install`. Run the Cardinal-focused tests with:

```powershell
node --test test\cardinal-db.test.js test\cardinal-message-store.test.js test\cardinal-control-plane.test.js test\app-runtime.test.js test\cardinal-client.test.js
node --test --test-name-pattern="Cardinal app manager starts|Cardinal app auto-start|Cardinal storage overview|Cardinal app database export|Cardinal app manager rejects|Cardinal creates a persistent|Cardinal control API|Cardinal app API" test\cardinal.test.js
```

The second command skips one older workspace-registration assertion that reads the missing root `start-website.ps1`; the app manager tests still run. The project-level `npm test` command also includes other website and integration tests.

When developing an app, keep its config seed free of credentials, write test data to a temporary directory, and test stop/restart behavior as well as a clean start. Do not point tests at a live `data\cardinal` folder.

## Publishing Cardinal source

Run `export-cardinal-to-github.bat` to make a uniquely named source folder and ZIP on your Desktop. When the export finishes, it opens the folder in Explorer and the command window stays open until you press a key. If the export fails, the error stays visible; check that the source files exist and the Desktop is writable. Failed runs clean up their own incomplete output. You can also run the script from PowerShell with `.\export-cardinal-to-github.ps1` to see the full error.

The ZIP contains Cardinal's core, app API, shared runtime/client/DB/TLS code, this guide, the launcher, and an empty `apps` folder ready for your own apps. It does not include installed apps, runtime data, tests, logs, certificates, or `node_modules`. Review the ZIP before publishing; never add your live `data\cardinal` folder or credentials to a public repository.

The ZIP is a source snapshot, not a ready-to-run backup of your installation. It includes a minimal package manifest for Cardinal's own dependencies; app folders and their extra dependencies are intentionally not included. Extract it, install Node.js 20+, run `npm install`, add your trusted apps under `apps`, configure Cardinal privately, and start it with `start-cardinal.bat`. Review the file list and run a secret scan before pushing any exported source to a public GitHub repository.
