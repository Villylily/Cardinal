const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { createManagementApi } = require('./api');

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getSessionId(req) {
    const cookieHeader = req.headers.cookie || '';
    const cookie = cookieHeader.split(';').map(part => part.trim())
        .find(part => part.startsWith('cardinal_session='));
    if (!cookie) return null;
    try {
        return decodeURIComponent(cookie.slice('cardinal_session='.length));
    } catch {
        return null;
    }
}

function createControlPlane({ manager, auth, settings, settingsPath, sessions, publicDir }) {
    const router = express.Router();
    const sendPublicFile = (fileName, res, next) => {
        res.sendFile(fileName, { root: publicDir }, error => {
            if (error) next(error);
        });
    };
    router.use(express.json({ limit: '1mb' }));
    router.get('/style.css', (req, res, next) => sendPublicFile('style.css', res, next));
    router.use((req, res, next) => {
        if (req.path === '/login' && ['GET', 'POST'].includes(req.method)) return next();
        const sessionId = getSessionId(req);
        const expiry = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
        if (expiry && expiry > Date.now()) return next();
        if (typeof sessionId === 'string') sessions.delete(sessionId);
        for (const [id, expiresAt] of sessions) {
            if (expiresAt <= Date.now()) sessions.delete(id);
        }
        if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'Authentication required.' });
        return res.redirect(`${req.baseUrl}/login`);
    });
    router.use('/api/v1', createManagementApi({
        manager,
        auth,
        settings,
        settingsPath,
        sessions
    }));

    router.post('/login', (req, res) => {
        if (!auth.username || !auth.password) {
            return res.status(503).json({ success: false, message: 'Set auth.username and auth.password in Cardinal configuration.' });
        }
        if (!safeEqual(req.body?.username, auth.username) || !safeEqual(req.body?.password, auth.password)) {
            return res.status(401).json({ success: false, message: 'Username or password is incorrect.' });
        }
        const sessionId = crypto.randomBytes(32).toString('base64url');
        sessions.set(sessionId, Date.now() + 12 * 60 * 60 * 1000);
        res.setHeader('Set-Cookie',
            `cardinal_session=${encodeURIComponent(sessionId)}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200; Path=/`);
        res.json({ success: true });
    });

    router.post('/logout', (req, res) => {
        const sessionId = getSessionId(req);
        if (typeof sessionId === 'string') sessions.delete(sessionId);
        res.setHeader('Set-Cookie', 'cardinal_session=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/');
        res.json({ success: true });
    });

    router.get('/api/apps', async (req, res, next) => {
        try {
            res.json({ success: true, apps: await manager.listStatus() });
        } catch (error) {
            next(error);
        }
    });

    router.get('/api/notifications', (req, res) => {
        res.json({ success: true, notifications: manager.listNotifications() });
    });

    router.get('/api/settings', (req, res) => {
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

    router.put('/api/settings', (req, res) => {
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
        res.json({
            success: true,
            restartRequired,
            reauthenticate: authChanged
        });
    });

    router.delete('/api/notifications/:id', (req, res) => {
        if (!manager.dismissNotification(req.params.id)) {
            return res.status(404).json({ success: false, message: 'Notification not found.' });
        }
        res.json({ success: true });
    });

    router.get('/app.js', (req, res, next) => {
        sendPublicFile('app.js', res, next);
    });

    router.post('/api/apps/:id/:action', async (req, res, next) => {
        try {
            if (!['start', 'stop', 'restart'].includes(req.params.action)) {
                return res.status(404).json({ success: false, message: 'Unknown app action.' });
            }
            const status = await manager[req.params.action](req.params.id);
            res.json({ success: true, app: status });
        } catch (error) {
            res.status(400).json({ success: false, message: error.message });
        }
    });

    router.get('/api/apps/:id/logs', async (req, res, next) => {
        try {
            res.json({ success: true, logs: await manager.readLogs(req.params.id) });
        } catch (error) {
            next(error);
        }
    });

    router.get('/api/apps/:id/config', (req, res, next) => {
        try {
            res.json({ success: true, config: manager.readAppConfig(req.params.id) });
        } catch (error) {
            next(error);
        }
    });

    router.put('/api/apps/:id/config', (req, res, next) => {
        try {
            let config = req.body?.config;
            if (typeof config === 'string') {
                try {
                    config = JSON.parse(config);
                } catch {
                    return res.status(400).json({ success: false, message: 'Config must be valid JSON.' });
                }
            }
            manager.writeAppConfig(req.params.id, config);
            const app = manager.getApp(req.params.id);
            const isRunning = manager.processes.get(app.id)?.status === 'running';
            res.json({ success: true, restartRequired: isRunning });
        } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
                return res.status(400).json({ success: false, message: error.message });
            }
            next(error);
        }
    });

    router.get(/.*/, (req, res, next) => {
        if (req.path.startsWith('/api/')) {
            return res.status(404).json({ success: false, message: 'Unknown Cardinal API route.' });
        }
        if (req.path === '/login') return sendPublicFile('login.html', res, next);
        return sendPublicFile('index.html', res, next);
    });

    router.use((error, req, res, next) => {
        console.error('Cardinal control-plane request failed:', error.message);
        if (res.headersSent) return next(error);
        const status = error.type === 'entity.too.large'
            ? 413
            : error.type === 'entity.parse.failed'
                ? 400
                : 500;
        if (status === 500) {
            return res.status(status).json({
                success: false,
                message: 'Cardinal could not complete the request.'
            });
        }
        res.status(status).json({
            success: false,
            message: status === 413 ? 'Request body is too large.' : 'Invalid JSON request body.'
        });
    });
    return router;
}

module.exports = { createControlPlane };
