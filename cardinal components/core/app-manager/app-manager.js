const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const pidusage = require('pidusage');
const { CardinalDB } = require('../../../libs/cardinal-db/cardinal-db');

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_RESPONSE_BYTES = 256 * 1024;

function isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function measureDirectory(directory) {
    let directoryStats;
    try {
        directoryStats = await fsPromises.lstat(directory);
    } catch (error) {
        if (error.code === 'ENOENT') return { bytes: 0, files: 0 };
        throw error;
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        return { bytes: 0, files: 0 };
    }

    let entries;
    try {
        entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return { bytes: 0, files: 0 };
        throw error;
    }

    let bytes = 0;
    let files = 0;
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            const nested = await measureDirectory(entryPath);
            bytes += nested.bytes;
            files += nested.files;
        } else if (entry.isFile()) {
            const stats = await fsPromises.stat(entryPath);
            bytes += stats.size;
            files += 1;
        }
    }
    return { bytes, files };
}

function validateId(id) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) {
        throw new Error(`Invalid Cardinal app ID: ${id}`);
    }
}

class AppManager {
    constructor({ rootDir, homeDir, appsDir }) {
        this.rootDir = path.resolve(rootDir);
        this.homeDir = path.resolve(homeDir);
        this.appsDir = path.resolve(appsDir);
        this.apps = new Map();
        this.processes = new Map();
        this.apiBaseUrl = null;
        this.notificationsPath = path.join(this.homeDir, 'notifications.json');
        this.autoStartPath = path.join(this.homeDir, 'config', 'app-autostart.json');
        fs.mkdirSync(this.appsDir, { recursive: true });
        fs.mkdirSync(path.dirname(this.autoStartPath), { recursive: true });
        this.autoStartOverrides = fs.existsSync(this.autoStartPath)
            ? readJson(this.autoStartPath)
            : {};
        if (!this.autoStartOverrides || typeof this.autoStartOverrides !== 'object' ||
            Array.isArray(this.autoStartOverrides) ||
            Object.values(this.autoStartOverrides).some(value => typeof value !== 'boolean')) {
            throw new Error(`Cardinal app auto-start settings must be an object of boolean values: ${this.autoStartPath}`);
        }
        this.notifications = fs.existsSync(this.notificationsPath)
            ? JSON.parse(fs.readFileSync(this.notificationsPath, 'utf8'))
            : [];
        if (!Array.isArray(this.notifications)) {
            throw new Error(`Cardinal notifications must be a JSON array: ${this.notificationsPath}`);
        }
    }

    setApiBaseUrl(url) {
        const parsed = new URL(url);
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
        if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
            throw new Error('Cardinal app API must use HTTP on a loopback address.');
        }
        this.apiBaseUrl = url.replace(/\/+$/, '');
    }

    discover() {
        this.apps.clear();
        for (const entry of fs.readdirSync(this.appsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const id = entry.name;
            validateId(id);
            const appDir = path.join(this.appsDir, id);
            const manifestPath = path.join(appDir, 'cardinal.app.json');
            if (!fs.existsSync(manifestPath)) continue;
            const manifest = readJson(manifestPath);
            if (!manifest || typeof manifest.entrypoint !== 'string' ||
                typeof manifest.workingDirectory !== 'string') {
                throw new Error(`Cardinal app manifest is incomplete: ${manifestPath}`);
            }
            const entrypoint = path.resolve(appDir, manifest.entrypoint);
            const workingDirectory = path.resolve(appDir, manifest.workingDirectory);
            if (!isWithin(this.rootDir, entrypoint) || !isWithin(this.rootDir, workingDirectory)) {
                throw new Error(`Cardinal app paths must remain inside the installation directory: ${id}`);
            }
            if (!fs.existsSync(entrypoint)) {
                throw new Error(`Cardinal app entrypoint does not exist: ${entrypoint}`);
            }
            if (!fs.statSync(entrypoint).isFile() || !fs.statSync(workingDirectory).isDirectory()) {
                throw new Error(`Cardinal app entrypoint or working directory is invalid: ${id}`);
            }
            this.apps.set(id, {
                id,
                name: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : id,
                description: typeof manifest.description === 'string' ? manifest.description : '',
                appDir,
                entrypoint,
                workingDirectory,
                configSeed: typeof manifest.configSeed === 'string'
                    ? path.resolve(appDir, manifest.configSeed)
                    : null,
                environment: manifest.environment && typeof manifest.environment === 'object'
                    ? manifest.environment
                    : {},
                dataSeeds: Array.isArray(manifest.dataSeeds) ? manifest.dataSeeds : [],
                autoStart: Object.hasOwn(this.autoStartOverrides, id)
                    ? this.autoStartOverrides[id]
                    : manifest.autoStart === true
            });
        }
        return [...this.apps.values()].map(({ id, name, description, autoStart }) =>
            ({ id, name, description, autoStart })
        );
    }

    setAutoStart(id, enabled) {
        const app = this.getApp(id);
        if (typeof enabled !== 'boolean') {
            throw new TypeError('App auto-start setting must be a boolean.');
        }
        const nextOverrides = { ...this.autoStartOverrides, [id]: enabled };
        const temporaryPath = `${this.autoStartPath}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, `${JSON.stringify(nextOverrides, null, 2)}\n`, {
                flag: 'wx',
                mode: 0o600
            });
            fs.renameSync(temporaryPath, this.autoStartPath);
        } catch (error) {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            throw error;
        }
        this.autoStartOverrides = nextOverrides;
        app.autoStart = enabled;
        return enabled;
    }

    async startAutoStartApps() {
        const apps = [...this.apps.values()].filter(app => app.autoStart);
        const results = [];
        for (const app of apps) {
            try {
                results.push({ id: app.id, success: true, app: await this.start(app.id) });
            } catch (error) {
                console.error(`Cardinal could not auto-start ${app.name}:`, error.message);
                try {
                    this.addNotification(app.id, {
                        title: `${app.name} did not start`,
                        message: error.message,
                        level: 'error'
                    });
                } catch (notificationError) {
                    console.error(`Could not record auto-start failure for ${app.name}:`, notificationError.message);
                }
                results.push({ id: app.id, success: false, error: error.message });
            }
        }
        return results;
    }

    getApp(id) {
        validateId(id);
        const app = this.apps.get(id);
        if (!app) throw new Error(`Unknown Cardinal app: ${id}`);
        return app;
    }

    getAppPaths(id) {
        const app = this.getApp(id);
        const appDataDir = path.join(this.homeDir, 'apps', id);
        return {
            appDataDir,
            configDir: path.join(appDataDir, 'config'),
            configPath: path.join(appDataDir, 'config', 'app.config.json'),
            logPath: path.join(appDataDir, 'logs', 'app.log')
        };
    }

    async getStorageOverview() {
        const apps = [];
        for (const app of this.apps.values()) {
            const { appDataDir } = this.getAppPaths(app.id);
            const storage = await measureDirectory(appDataDir);
            let databaseBytes = 0;
            let collections = 0;
            const databaseDirectory = path.join(appDataDir, 'database');
            let databaseEntries;
            try {
                const databaseStats = await fsPromises.lstat(databaseDirectory);
                databaseEntries = databaseStats.isDirectory() && !databaseStats.isSymbolicLink()
                    ? await fsPromises.readdir(databaseDirectory, { withFileTypes: true })
                    : [];
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                databaseEntries = [];
            }
            for (const entry of databaseEntries) {
                if (!entry.isFile() || !/^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(entry.name)) continue;
                const stats = await fsPromises.stat(path.join(databaseDirectory, entry.name));
                databaseBytes += stats.size;
                collections += 1;
            }
            apps.push({
                id: app.id,
                name: app.name,
                bytes: storage.bytes,
                files: storage.files,
                databaseBytes,
                collections
            });
        }
        apps.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
        return {
            totalBytes: apps.reduce((total, app) => total + app.bytes, 0),
            totalFiles: apps.reduce((total, app) => total + app.files, 0),
            databaseBytes: apps.reduce((total, app) => total + app.databaseBytes, 0),
            collections: apps.reduce((total, app) => total + app.collections, 0),
            apps
        };
    }

    async exportAppDatabase(id) {
        const { appDataDir } = this.getAppPaths(id);
        const database = new CardinalDB({ directory: path.join(appDataDir, 'database') });
        const backup = await database.exportAll();
        return {
            format: backup.format,
            version: backup.version,
            exportedAt: backup.exportedAt,
            appId: id,
            collections: backup.collections
        };
    }

    async doctorAppDatabase(id, options) {
        const { appDataDir } = this.getAppPaths(id);
        const database = new CardinalDB({ directory: path.join(appDataDir, 'database') });
        return database.doctor(options);
    }

    ensureAppData(app) {
        const paths = this.getAppPaths(app.id);
        fs.mkdirSync(paths.configDir, { recursive: true });
        fs.mkdirSync(path.dirname(paths.logPath), { recursive: true });
        for (const seed of app.dataSeeds) {
            if (!seed || typeof seed.source !== 'string' || typeof seed.target !== 'string') {
                throw new Error(`Invalid data seed in app manifest: ${app.id}`);
            }
            const source = path.resolve(app.appDir, seed.source);
            const destination = path.resolve(paths.appDataDir, seed.target);
            if (!isWithin(this.rootDir, source) || !isWithin(paths.appDataDir, destination)) {
                throw new Error(`App data seed paths must remain inside Cardinal directories: ${app.id}`);
            }
            if (!fs.existsSync(destination) && fs.existsSync(source)) {
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            }
        }
        if (!fs.existsSync(paths.configPath)) {
            if (app.configSeed && fs.existsSync(app.configSeed)) {
                fs.copyFileSync(app.configSeed, paths.configPath, fs.constants.COPYFILE_EXCL);
            } else {
                fs.writeFileSync(paths.configPath, '{}\n', { flag: 'wx' });
            }
        }
        return paths;
    }

    readAppConfig(id) {
        const { configPath } = this.ensureAppData(this.getApp(id));
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error(`App config must contain a JSON object: ${configPath}`);
        }
        return config;
    }

    writeAppConfig(id, config) {
        const { configPath } = this.ensureAppData(this.getApp(id));
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new TypeError('App config must be a JSON object.');
        }
        let serialized;
        try {
            serialized = `${JSON.stringify(config, null, 2)}\n`;
        } catch (error) {
            throw new TypeError(`App config must be JSON serializable: ${error.message}`);
        }
        if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
            throw new RangeError('App config cannot exceed 1 MB.');
        }
        const temporaryPath = `${configPath}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, serialized, { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporaryPath, configPath);
        } catch (error) {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            throw error;
        }
        return config;
    }

    async start(id) {
        const app = this.getApp(id);
        const current = this.processes.get(id);
        if (current && !['stopped', 'errored'].includes(current.status)) {
            throw new Error(`${app.name} is already ${current.status}.`);
        }
        const paths = this.ensureAppData(app);
        const apiToken = this.apiBaseUrl ? crypto.randomBytes(32).toString('base64url') : null;
        const logSize = fs.existsSync(paths.logPath) ? fs.statSync(paths.logPath).size : 0;
        if (logSize > MAX_LOG_BYTES) {
            const contents = fs.readFileSync(paths.logPath);
            const keep = contents.subarray(Math.max(0, contents.length - MAX_LOG_BYTES / 2));
            fs.writeFileSync(paths.logPath, keep);
        }
        const logStream = fs.createWriteStream(paths.logPath, { flags: 'a' });
        const env = {
            ...process.env,
            ...(app.environment || {}),
            CARDINAL_HOME: this.homeDir,
            CARDINAL_APP_ID: id,
            CARDINAL_APP_DATA_DIR: paths.appDataDir,
            CARDINAL_APP_CONFIG: paths.configPath,
            ...(this.apiBaseUrl ? {
                CARDINAL_API_URL: this.apiBaseUrl,
                CARDINAL_API_TOKEN: apiToken
            } : {})
        };
        const child = spawn(process.execPath, [app.entrypoint], {
            cwd: app.workingDirectory,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const state = {
            child,
            status: 'starting',
            startedAt: Date.now(),
            lastError: null,
            logStream,
            pid: child.pid || null,
            apiToken
        };
        this.processes.set(id, state);
        const appendLog = (stream, chunk) => {
            const line = `[${new Date().toISOString()}] [${stream}] ${chunk.toString()}`;
            logStream.write(line.endsWith('\n') ? line : `${line}\n`);
        };
        child.stdout.on('data', chunk => appendLog('stdout', chunk));
        child.stderr.on('data', chunk => appendLog('stderr', chunk));
        child.once('spawn', () => { state.status = 'running'; });
        child.once('error', error => {
            state.status = 'errored';
            state.apiToken = null;
            state.lastError = error.message;
            appendLog('manager', `Failed to start app: ${error.message}`);
            logStream.end();
        });
        child.once('close', (code, signal) => {
            state.status = state.status === 'errored' ? 'errored' : 'stopped';
            state.apiToken = null;
            state.exitCode = code;
            state.exitSignal = signal;
            state.stoppedAt = Date.now();
            logStream.end();
        });
        logStream.once('error', error => {
            state.lastError = `Could not write app log: ${error.message}`;
        });
        await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        });
        return this.getStatus(id);
    }

    async stop(id) {
        const app = this.getApp(id);
        const state = this.processes.get(id);
        if (!state || ['stopped', 'errored'].includes(state.status)) {
            throw new Error(`${app.name} is not running.`);
        }
        state.status = 'stopping';
        state.apiToken = null;
        const child = state.child;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
            }, 10000);
            timer.unref();
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            child.once('error', error => {
                clearTimeout(timer);
                reject(error);
            });
            if (!child.kill('SIGTERM')) {
                clearTimeout(timer);
                reject(new Error(`${app.name} process could not be signalled.`));
            }
        });
        return this.getStatus(id);
    }

    async restart(id) {
        const state = this.processes.get(id);
        if (state && !['stopped', 'errored'].includes(state.status)) await this.stop(id);
        return this.start(id);
    }

    async getStatus(id) {
        const app = this.getApp(id);
        const state = this.processes.get(id);
        const paths = this.getAppPaths(id);
        let resources = null;
        if (state?.child.pid && state.status === 'running') {
            try {
                const usage = await pidusage(state.child.pid);
                resources = {
                    memoryBytes: usage.memory,
                    cpuPercent: usage.cpu
                };
            } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
        }
        return {
            id,
            name: app.name,
            description: app.description,
            autoStart: app.autoStart,
            status: state?.status || 'stopped',
            pid: state?.child.pid || null,
            uptimeSeconds: state?.status === 'running'
                ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))
                : 0,
            resources,
            lastError: state?.lastError || null,
            exitCode: state?.exitCode ?? null
        };
    }

    async listStatus() {
        return Promise.all([...this.apps.keys()].map(id => this.getStatus(id)));
    }

    authorizeApiToken(token) {
        if (typeof token !== 'string' || token.length > 256) return null;
        const candidate = Buffer.from(token);
        for (const [id, state] of this.processes) {
            if (!state.apiToken || !['starting', 'running'].includes(state.status)) continue;
            const expected = Buffer.from(state.apiToken);
            if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) return id;
        }
        return null;
    }

    addNotification(appId, { title, message, level = 'info' }) {
        const app = this.getApp(appId);
        const notification = {
            id: crypto.randomUUID(),
            appId,
            appName: app.name,
            title,
            message,
            level,
            createdAt: new Date().toISOString()
        };
        this.notifications.push(notification);
        this.notifications = this.notifications.slice(-100);
        this.persistNotifications();
        return notification;
    }

    listNotifications() {
        return [...this.notifications].reverse();
    }

    dismissNotification(id) {
        const nextNotifications = this.notifications.filter(notification => notification.id !== id);
        if (nextNotifications.length === this.notifications.length) return false;
        this.notifications = nextNotifications;
        this.persistNotifications();
        return true;
    }

    persistNotifications() {
        const temporaryPath = `${this.notificationsPath}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, `${JSON.stringify(this.notifications, null, 2)}\n`, {
                flag: 'wx',
                mode: 0o600
            });
            fs.renameSync(temporaryPath, this.notificationsPath);
        } catch (error) {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            throw error;
        }
    }

    async readLogs(id, limitBytes = MAX_LOG_RESPONSE_BYTES) {
        const { logPath } = this.getAppPaths(id);
        if (!fs.existsSync(logPath)) return '';
        const stats = await fs.promises.stat(logPath);
        const length = Math.min(stats.size, Math.max(1, Math.min(limitBytes, MAX_LOG_RESPONSE_BYTES)));
        const buffer = Buffer.alloc(length);
        const handle = await fs.promises.open(logPath, 'r');
        try {
            await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
        } finally {
            await handle.close();
        }
        return buffer.toString('utf8');
    }
}

module.exports = { AppManager };
