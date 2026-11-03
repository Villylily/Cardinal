const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const https = require('node:https');
const { AppManager } = require('./app-manager/app-manager');
const { createControlPlane } = require('./control-plane/control-plane');
const { ensureSelfSignedCertificate } = require('./tls-certificates/tls-certificates');
const { createAppApi } = require('../../apis/app-api');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const HOME_DIR = path.resolve(process.env.CARDINAL_HOME || path.join(ROOT_DIR, 'data', 'cardinal'));
const CONFIG_PATH = path.join(HOME_DIR, 'config', 'cardinal.config.json');
const APPS_DIR = path.join(ROOT_DIR, 'apps');
const PUBLIC_DIR = path.join(ROOT_DIR, 'cardinal components', 'control-plane');

function isCardinalAlreadyRunning(config) {
    return new Promise(resolve => {
        const request = https.get({
            hostname: config.listenHost,
            port: config.port,
            path: '/control/login',
            rejectUnauthorized: false,
            timeout: 3000
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve(
                response.statusCode === 200 && body.includes('Cardinal Login')
            ));
        });
        request.once('timeout', () => request.destroy());
        request.once('error', () => resolve(false));
    });
}

function loadConfig() {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
        const example = path.join(ROOT_DIR, 'cardinal components', 'core', 'cardinal.config.example.json');
        fs.copyFileSync(example, CONFIG_PATH, fs.constants.COPYFILE_EXCL);
        throw new Error(`Created ${CONFIG_PATH}. Set a non-empty auth.password before starting Cardinal.`);
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config || typeof config !== 'object' || !config.auth ||
        typeof config.auth.username !== 'string' || !config.auth.username.trim() ||
        typeof config.auth.password !== 'string' || !config.auth.password) {
        throw new Error(`Cardinal auth.username and auth.password must be set in ${CONFIG_PATH}.`);
    }
    const port = Number(config.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Cardinal port must be between 1 and 65535 in ${CONFIG_PATH}.`);
    }
    const host = typeof config.listenHost === 'string' && config.listenHost.trim()
        ? config.listenHost.trim()
        : '127.0.0.1';
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
        throw new Error('Cardinal currently only supports loopback binding until HTTPS is configured.');
    }
    return { ...config, port, listenHost: host };
}

async function startCardinal() {
    const config = loadConfig();
    const tlsOptions = await ensureSelfSignedCertificate(path.join(HOME_DIR, 'certs'));
    const manager = new AppManager({ rootDir: ROOT_DIR, homeDir: HOME_DIR, appsDir: APPS_DIR });
    manager.discover();
    const sessions = new Map();
    const app = express();
    app.disable('x-powered-by');
    app.use('/control', createControlPlane({
        manager,
        auth: config.auth,
        settings: config,
        settingsPath: CONFIG_PATH,
        sessions,
        publicDir: PUBLIC_DIR
    }));
    app.get('/login', (req, res) => res.redirect('/control/login'));
    app.get('/', (req, res) => res.redirect('/control'));
    const appApi = express();
    appApi.disable('x-powered-by');
    appApi.use(createAppApi({ manager }));
    const appApiServer = http.createServer(appApi);
    await new Promise((resolve, reject) => {
        appApiServer.once('error', reject);
        appApiServer.listen(0, '127.0.0.1', resolve);
    });
    const appApiAddress = appApiServer.address();
    manager.setApiBaseUrl(`http://127.0.0.1:${appApiAddress.port}/v1`);
    const server = https.createServer(tlsOptions, app);
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(config.port, config.listenHost, resolve);
        });
    } catch (error) {
        await new Promise(resolve => appApiServer.close(resolve));
        if (error.code === 'EADDRINUSE' && await isCardinalAlreadyRunning(config)) {
            console.log(`Cardinal is already running at https://${config.listenHost}:${config.port}/control`);
            return;
        }
        throw error;
    }
    console.log(`Cardinal is available at https://${config.listenHost}:${config.port}/control`);
    console.log(`Cardinal data and configuration: ${HOME_DIR}`);
    console.warn('Cardinal uses a self-signed certificate. Your browser will show a trust warning until you explicitly trust this local certificate.');
    await manager.startAutoStartApps();

    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        const statuses = await manager.listStatus();
        await Promise.all(statuses
            .filter(status => status.status === 'running' || status.status === 'starting')
            .map(status => manager.stop(status.id)));
        await Promise.all([
            new Promise(resolve => server.close(resolve)),
            new Promise(resolve => appApiServer.close(resolve))
        ]);
    };
    process.once('SIGINT', () => {
        void close().catch(error => {
            console.error('Cardinal could not shut down cleanly:', error.message);
            process.exitCode = 1;
        });
    });
    process.once('SIGTERM', () => {
        void close().catch(error => {
            console.error('Cardinal could not shut down cleanly:', error.message);
            process.exitCode = 1;
        });
    });
}

startCardinal().catch(error => {
    console.error('Cardinal could not start:', error.message);
    process.exitCode = 1;
});
