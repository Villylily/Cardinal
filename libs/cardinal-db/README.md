# Cardinal DB

Cardinal DB stores JSON collections in an app-scoped database directory. Mutations use serialized transactions and atomic file replacement; collection export/import and whole-database backups are supported.

For adding an app, a complete Cardinal DB example, and the rest of the app API, see the [Cardinal app guide](../../CARDINAL.md).

## Use Cardinal DB in an app

When Cardinal starts an app, it sets `CARDINAL_APP_DATA_DIR`. The database uses a `database` folder inside it automatically:

```js
const { CardinalDB } = require('../../libs/cardinal-db/cardinal-db');

const database = new CardinalDB();
await database.set('players', 'player-123', { name: 'Alex', visits: 1 });
const player = await database.get('players', 'player-123');
```

The path is app-specific and survives app restarts and updates. For standalone scripts or tests, pass an explicit `{ directory }` instead. Cardinal DB refuses to guess a directory when neither option is provided.

## Database doctor

`database.doctor()` reports malformed collection files, unsupported formats, unsafe files, and interrupted atomic writes without changing data. `database.doctor({ repair: true })` restores a valid interrupted write or salvages valid records from a damaged collection. Before replacing damaged data, it preserves the original under the database's `recovery` directory. Unsupported formats and data that cannot be safely recovered are left untouched and reported.

The Cardinal control plane exposes the same check and repair actions in **App configs** after selecting an app. Export a backup before repair when possible.

## Paged message history

The optional `CardinalMessageStore` restores the earlier page-based message API on top of Cardinal DB collections:

```js
const { CardinalDB, CardinalMessageStore } = require('./cardinal-db');

const database = new CardinalDB({ directory: appDatabaseDirectory });
const messages = new CardinalMessageStore({ database, pageSize: 50 });
const message = await messages.insert({ username: 'Player', text: 'Hello!' });
const latest = await messages.getRecentHistory();
```

It also supports older-page reads, ID lookup, text edits, reactions, deletion, counting, and clearing its own history collection. Methods are asynchronous and persist through Cardinal DB transactions.
