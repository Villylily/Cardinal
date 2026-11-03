const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const API_DESCRIPTION = {
    version: '1.0',
    basePath: '/control/api/v1',
    authentication: 'Use the authenticated Cardinal HTTPS session cookie.',
    appApi: {
        access: 'Only apps running on this computer can use it. Each running app gets a private access token.',
        routes: [
            { method: 'GET', path: '/app', description: 'Find out which app is connected.' },
            { method: 'GET', path: '/app/config', description: 'Read this app’s config.' },
            { method: 'PUT', path: '/app/config', description: 'Save this app’s config.' },
            { method: 'POST', path: '/notifications', description: 'Send Cardinal a message.' }
        ]
    },
    routes: [
        { method: 'GET', path: '/', description: 'See the available API routes.' },
        { method: 'GET', path: '/apps', description: 'List your apps and whether they’re running.' },
        { method: 'GET', path: '/storage', description: 'See how much space app files use.' },
        { method: 'GET', path: '/apps/:id', description: 'Get an app’s current state.' },
        { method: 'POST', path: '/apps/:id/actions/:action', description: 'Start, stop, or restart an app.' },
        { method: 'PUT', path: '/apps/:id/auto-start', description: 'Choose if an app starts with Cardinal.' },
        { method: 'GET', path: '/apps/:id/database/export', description: 'Download a backup of an app’s saved data.' },
        { method: 'POST', path: '/apps/:id/database/doctor', description: 'Check or fix an app’s saved data.' },
        { method: 'GET', path: '/apps/:id/config', description: 'Read an app’s config.' },
        { method: 'PUT', path: '/apps/:id/config', description: 'Save an app’s config.' },
        { method: 'GET', path: '/apps/:id/logs', description: 'Read an app’s recent logs.' },
        { method: 'GET', path: '/settings', description: 'Read Cardinal’s public settings.' },
        { method: 'PUT', path: '/settings', description: 'Change Cardinal’s address, port, or login.' },
        { method: 'GET', path: '/notifications', description: 'Read messages from your apps.' },
        { method: 'DELETE', path: '/notifications/:id', description: 'Clear an app message.' }
    ]
};

function createManagementApi({ manager, auth, settings, settingsPath, sessions }) {
    const router = express.Router();

    router.get('/', (req, res) => {
        res.json({ success: true, api: API_DESCRIPTION });
    });

    router.get('/apps', async (req, res, next) => {
        try {
            res.json({ success: true, apps: await manager.listStatus() });
        } catch (error) {
            next(error);
        }
    });

    router.get('/storage', async (req, res, next) => {
        try {
            res.json({ success: true, storage: await manager.getStorageOverview() });
        } catch (error) {
            next(error);
        }
    });

    router.get('/apps/:id', async (req, res, next) => {
        try {
            res.json({ success: true, app: await manager.getStatus(req.params.id) });
        } catch (error) {
            next(error);
        }
    });

    router.post('/apps/:id/actions/:action', async (req, res, next) => {
        try {
            if (!['start', 'stop', 'restart'].includes(req.params.action)) {
                return res.status(404).json({ success: false, message: 'Unknown app action.' });
            }
            const app = await manager[req.params.action](req.params.id);
            res.json({ success: true, app });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    });

    router.put('/apps/:id/auto-start', (req, res, next) => {
        try {
            const enabled = req.body?.enabled;
            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ success: false, message: 'Auto-start enabled must be a boolean.' });
            }
            manager.setAutoStart(req.params.id, enabled);
            res.json({ success: true, autoStart: enabled });
        } catch (error) {
            if (error instanceof TypeError) {
                return res.status(400).json({ success: false, message: error.message });
            }
            next(error);
        }
    });

    router.get('/apps/:id/database/export', async (req, res, next) => {
        try {
            const backup = await manager.exportAppDatabase(req.params.id);
            res.setHeader('Content-Disposition', `attachment; filename="cardinal-${backup.appId}-database-${backup.exportedAt.slice(0, 10)}.json"`);
            res.json({ success: true, backup });
        } catch (error) {
            if (error instanceof RangeError) {
                return res.status(413).json({ success: false, message: error.message });
            }
            next(error);
        }
    });

    router.post('/apps/:id/database/doctor', async (req, res, next) => {
        try {
            const repair = req.body?.repair ?? false;
            if (typeof repair !== 'boolean') {
                return res.status(400).json({
                    success: false,
                    message: 'Database doctor repair must be a boolean.'
                });
            }
            const report = await manager.doctorAppDatabase(req.params.id, { repair });
            res.json({ success: true, report });
        } catch (error) {
            next(error);
        }
    });

    router.get('/apps/:id/config', (req, res, next) => {
        try {
            res.json({ success: true, config: manager.readAppConfig(req.params.id) });
        } catch (error) {
            next(error);
        }
    });

    router.put('/apps/:id/config', (req, res, next) => {
        try {
            manager.writeAppConfig(req.params.id, req.body?.config);
            res.json({
                success: true,
                restartRequired: manager.processes.get(req.params.id)?.status === 'running'
            });
        } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
                return res.status(400).json({ success: false, message: error.message });
            }
            next(error);
        }
    });

    router.get('/apps/:id/logs', async (req, res, next) => {
        try {
            res.json({ success: true, logs: await manager.readLogs(req.params.id) });
        } catch (error) {
            next(error);
        }
    });

    router.get('/settings', (req, res) => {
        res.json({
            success: true,
            settings: {
                listenHost: settings?.listenHost || '127.0.0.1',
                port: settings?.port || null,
                auth: {
                    username: auth.username,
                    passwordConfigured: Boolean(auth.password)
                }
            }
        });
    });

    router.put('/settings', (req, res) => {
        if (!settings || !settingsPath) {
            return res.status(503).json({ success: false, message: 'Cardinal settings are not writable.' });
        }
        const update = req.body?.settings;
        const listenHost = update?.listenHost;
        const port = update?.port;
        const username = update?.auth?.username;
        const newPassword = update?.auth?.password;
        if (!['127.0.0.1', 'localhost', '::1'].includes(listenHost) ||
            !Number.isInteger(port) || port < 1 || port > 65535 ||
            typeof username !== 'string' || !username.trim() || username.length > 128 ||
            (newPassword !== undefined && (typeof newPassword !== 'string' || newPassword.length > 1024))) {
            return res.status(400).json({
                success: false,
                message: 'Use a loopback host, port 1-65535, a username, and a password no longer than 1024 characters.'
            });
        }
        const authChanged = auth.username !== username.trim() ||
            (typeof newPassword === 'string' && newPassword.length > 0 && auth.password !== newPassword);
        const restartRequired = settings.listenHost !== listenHost || settings.port !== port;
        const nextConfig = {
            ...settings,
            listenHost,
            port,
            auth: {
                ...auth,
                username: username.trim(),
                password: typeof newPassword === 'string' && newPassword.length > 0
                    ? newPassword
                    : auth.password
            }
        };
        const temporaryPath = `${settingsPath}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
                flag: 'wx',
                mode: 0o600
            });
            fs.renameSync(temporaryPath, settingsPath);
        } catch (error) {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            console.error('Cardinal settings could not be saved:', error.message);
            return res.status(500).json({ success: false, message: 'Cardinal settings could not be saved.' });
        }
        settings.listenHost = listenHost;
        settings.port = port;
        auth.username = nextConfig.auth.username;
        auth.password = nextConfig.auth.password;
        if (authChanged) sessions.clear();
        res.json({ success: true, restartRequired, reauthenticate: authChanged });
    });

    router.get('/notifications', (req, res) => {
        res.json({ success: true, notifications: manager.listNotifications() });
    });

    router.delete('/notifications/:id', (req, res) => {
        if (!manager.dismissNotification(req.params.id)) {
            return res.status(404).json({ success: false, message: 'Notification not found.' });
        }
        res.json({ success: true });
    });

    router.use((req, res) => {
        res.status(404).json({ success: false, message: 'Unknown Cardinal API route.' });
    });

    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error.type === 'entity.too.large') {
            return res.status(413).json({ success: false, message: 'Request body is too large.' });
        }
        if (error.type === 'entity.parse.failed') {
            return res.status(400).json({ success: false, message: 'Invalid JSON request body.' });
        }
        console.error('Cardinal API request failed:', error.message);
        res.status(500).json({ success: false, message: 'Cardinal could not complete the API request.' });
    });
    return router;
}

module.exports = { createManagementApi, API_DESCRIPTION };
