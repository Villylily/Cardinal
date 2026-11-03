<p align="center">
  <img width="1200" height="360" alt="Cardinal wordmark" src="https://github.com/user-attachments/assets/db8b9911-4d86-4edd-a930-dbca182291df">
</p>

# Cardinal

**Docker but... Node.js**

Cardinal is a small Node.js app manager. It starts and stops apps, keeps each app's settings and data in its own place, and gives apps a local API to talk to Cardinal. Cardinal DB is its built-in JSON collection database for app data.

This repository export contains Cardinal and Cardinal DB source. It does not include your installed apps or private runtime data.

## What it does

- Finds apps in `apps/<app-id>` using a `cardinal.app.json` manifest.
- Starts, stops, and restarts apps, with optional start-with-Cardinal settings.
- Keeps app configuration, logs, and databases in Cardinal's separate data folder.
- Provides an authenticated control panel for app status, settings, logs, backups, and database checks.
- Gives each running app a private local API for reading its own settings and sending notifications.
- Provides Cardinal DB: a dependency-free JSON collection store with async reads, writes, transactions, backup, and recovery tools.

## Quick start

You need Node.js 20 or newer.

1. Install dependencies from the repository folder:

   ```powershell
   npm install
   ```

2. Start Cardinal:

   ```powershell
   .\start-cardinal.bat
   ```

   Or use `node cardinal.js`.

3. On the first run, Cardinal creates `data\cardinal\config\cardinal.config.json` and exits. Set a username and password in that private file, then start Cardinal again.
4. Open [https://127.0.0.1:6868/control](https://127.0.0.1:6868/control) and sign in. The local HTTPS certificate is self-signed, so your browser may show a certificate warning.

Cardinal only listens on a loopback address by default. To store runtime files somewhere else, set `CARDINAL_HOME` before starting it. Keep the Cardinal data folder private; it contains passwords, app configs, databases, logs, and certificates.

## Add an app

Make a folder such as `apps\hello-cardinal` with a `cardinal.app.json` manifest and a Node.js entrypoint. A minimal manifest looks like this:

```json
{
  "name": "Hello Cardinal",
  "description": "A small Cardinal app.",
  "entrypoint": "app.js",
  "workingDirectory": ".",
  "autoStart": false
}
```

Add apps directly under `apps`; restart Cardinal after adding or removing app folders. App IDs use lowercase letters, numbers, underscores, and hyphens. App processes run with your Windows account permissions, so only install code you trust.

## Cardinal DB

Cardinal DB keeps each app's collections under `data\cardinal\apps\<app-id>\database`. A managed app can open its own database like this:

```js
const { CardinalDB } = require('../../libs/cardinal-db/cardinal-db');

const database = new CardinalDB();
await database.set('players', 'player-123', { name: 'Alex' });
const player = await database.get('players', 'player-123');
```

The database uses `CARDINAL_APP_DATA_DIR` to find the app's private data folder. For standalone scripts, pass an explicit `{ directory }`. Values must be JSON-serializable. Database operations are asynchronous.

## More docs

- [Full Cardinal app and API guide](CARDINAL.md)
- [Cardinal DB guide](libs/cardinal-db/README.md)
- [License and attributions](CARDINAL-LICENSE.md)

## Tests

From the repository folder:

```powershell
npm test
npm run test:apps
```

## License

Cardinal and Cardinal DB use the [PolyForm Noncommercial License 1.0.0](CARDINAL-LICENSE.md). Third-party dependencies keep their own licenses; see the [license notice](CARDINAL-LICENSE.md) for project scope and attributions.

## Coming soon..... :p

Cardinal is still being built, so expect things to change and more stuff to show up here.
