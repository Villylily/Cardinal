const express = require('express');

const LEVELS = new Set(['info', 'success', 'warning', 'error']);

function createAppApi({ manager }) {
    const router = express.Router();
    router.use(express.json({ limit: '1mb' }));
    router.use('/v1', (req, res, next) => {
        const authorization = req.get('authorization') || '';
        const match = authorization.match(/^Bearer ([A-Za-z0-9_-]+)$/);
        const appId = match ? manager.authorizeApiToken(match[1]) : null;
        if (!appId) {
            return res.status(401).json({ success: false, message: 'A valid running-app token is required.' });
        }
        req.cardinalAppId = appId;
        next();
    });

    router.get('/v1/app', (req, res) => {
        const app = manager.getApp(req.cardinalAppId);
        res.json({
            success: true,
            app: { id: app.id, name: app.name, description: app.description }
        });
    });

    router.get('/v1/app/config', (req, res, next) => {
        try {
            res.json({ success: true, config: manager.readAppConfig(req.cardinalAppId) });
        } catch (error) {
            next(error);
        }
    });

    router.put('/v1/app/config', (req, res, next) => {
        try {
            manager.writeAppConfig(req.cardinalAppId, req.body?.config);
            res.json({ success: true, restartRequired: true });
        } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
                return res.status(400).json({ success: false, message: error.message });
            }
            next(error);
        }
    });

    router.post('/v1/notifications', (req, res, next) => {
        try {
            const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
            const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
            const level = req.body?.level === undefined ? 'info' : req.body.level;
            if (!title || title.length > 100 || !message || message.length > 2000 ||
                typeof level !== 'string' || !LEVELS.has(level)) {
                return res.status(400).json({
                    success: false,
                    message: 'Notification requires a title (1-100 chars), message (1-2000 chars), and valid level.'
                });
            }
            const notification = manager.addNotification(req.cardinalAppId, { title, message, level });
            return res.status(201).json({ success: true, notification });
        } catch (error) {
            return next(error);
        }
    });

    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const status = error.type === 'entity.too.large'
            ? 413
            : error.type === 'entity.parse.failed'
                ? 400
                : 500;
        if (status === 500) console.error('Cardinal app API request failed:', error.message);
        res.status(status).json({
            success: false,
            message: status === 500 ? 'Cardinal could not accept the app request.' : 'Invalid request body.'
        });
    });
    return router;
}

module.exports = { createAppApi };
