const path = require('node:path');

function getAppPaths(appId) {
    if (typeof appId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(appId)) {
        throw new Error(`Invalid Cardinal app ID: ${appId}`);
    }
    const rootDir = path.resolve(__dirname, '..', '..');
    const homeDir = path.resolve(process.env.CARDINAL_HOME || path.join(rootDir, 'data', 'cardinal'));
    const appDataDir = path.resolve(process.env.CARDINAL_APP_DATA_DIR || path.join(homeDir, 'apps', appId));
    const configPath = path.resolve(process.env.CARDINAL_APP_CONFIG || path.join(appDataDir, 'config', 'app.config.json'));
    return { rootDir, homeDir, appDataDir, configPath };
}

module.exports = { getAppPaths };
