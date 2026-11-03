const appGrid = document.getElementById('appGrid');
const notificationList = document.getElementById('notificationList');
const appConfigSelect = document.getElementById('appConfigSelect');
const appConfigEditor = document.getElementById('appConfigEditor');
const settingsStatus = document.getElementById('settingsStatus');
const cardinalSettingsStatus = document.getElementById('cardinalSettingsStatus');
const apiStatus = document.getElementById('apiStatus');
const pageError = document.getElementById('pageError');
const detailsDialog = document.getElementById('detailsDialog');
const logStatus = document.getElementById('logStatus');
const liveLogsButton = document.getElementById('toggleLiveLogs');
let currentLogAppId = null;
let liveLogTimer = null;
let liveLogRefreshPending = false;
let logRequestVersion = 0;
let lastNotificationsSnapshot = null;
let lastSettingsAppsSnapshot = null;

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Storage response contained an invalid byte count.');
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

function makeButton(label, action, appId, disabled = false) {
    const button = document.createElement('button');
    button.textContent = label;
    button.disabled = disabled;
    if (label === 'Logs') button.className = 'secondary';
    button.addEventListener('click', () => action(appId));
    return button;
}

async function api(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers }
    });
    if (response.status === 401) {
        location.href = '/control/login';
        throw new Error('Your session expired.');
    }
    const result = await response.json();
    if (!response.ok || !result.success) {
        throw new Error(result.message || `Request failed (${response.status}).`);
    }
    return result;
}

async function showLogs(appId) {
    const appCard = [...appGrid.children].find(card => card.dataset.app === appId);
    const appName = appCard?.querySelector('h3')?.textContent || appId;
    document.getElementById('dialogTitle').textContent = `${appName} logs`;
    currentLogAppId = appId;
    stopLiveLogUpdates();
    document.getElementById('detailsContent').textContent = 'Loading logs…';
    logStatus.textContent = '';
    detailsDialog.showModal();
    await refreshLogs(true);
}

async function refreshLogs(scrollToBottom = false) {
    if (!currentLogAppId || liveLogRefreshPending) return;
    const appId = currentLogAppId;
    const requestVersion = ++logRequestVersion;
    const content = document.getElementById('detailsContent');
    liveLogRefreshPending = true;
    try {
        const result = await api(`/control/api/v1/apps/${encodeURIComponent(appId)}/logs`);
        if (requestVersion !== logRequestVersion || currentLogAppId !== appId) return;
        content.textContent = result.logs || '(No logs yet.)';
        logStatus.textContent = `Last checked ${new Date().toLocaleTimeString()}.`;
        logStatus.className = 'settings-status success';
        if (scrollToBottom || liveLogsButton.getAttribute('aria-pressed') === 'true') {
            content.scrollTop = content.scrollHeight;
        }
    } catch (error) {
        if (requestVersion !== logRequestVersion || currentLogAppId !== appId) return;
        logStatus.textContent = error.message;
        logStatus.className = 'settings-status error';
    } finally {
        const refreshCurrentApp = detailsDialog.open &&
            currentLogAppId &&
            requestVersion !== logRequestVersion;
        liveLogRefreshPending = false;
        if (refreshCurrentApp) void refreshLogs(true);
    }
}

function stopLiveLogUpdates() {
    clearTimeout(liveLogTimer);
    liveLogTimer = null;
    liveLogsButton.setAttribute('aria-pressed', 'false');
    liveLogsButton.textContent = 'Keep updating';
}

function scheduleLiveLogRefresh() {
    clearTimeout(liveLogTimer);
    liveLogTimer = setTimeout(async () => {
        liveLogTimer = null;
        if (liveLogsButton.getAttribute('aria-pressed') !== 'true' || !detailsDialog.open) return;
        await refreshLogs();
        if (liveLogsButton.getAttribute('aria-pressed') === 'true' && detailsDialog.open) {
            scheduleLiveLogRefresh();
        }
    }, 2000);
}

function renderSettingsApps(apps) {
    const snapshot = JSON.stringify(apps.map(app => [app.id, app.name]));
    if (snapshot === lastSettingsAppsSnapshot) return;
    lastSettingsAppsSnapshot = snapshot;
    const selectedId = appConfigSelect.value;
    appConfigSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Pick an app';
    appConfigSelect.appendChild(placeholder);
    for (const app of apps) {
        const option = document.createElement('option');
        option.value = app.id;
        option.textContent = app.name;
        appConfigSelect.appendChild(option);
    }
    if (apps.some(app => app.id === selectedId)) appConfigSelect.value = selectedId;
}

function appMetricValues(app) {
    return [
        `Uptime: ${app.uptimeSeconds}s`,
        app.resources
            ?             `Memory: ${(app.resources.memoryBytes / 1024 / 1024).toFixed(1)} MB`
                : 'Memory: —',
        app.resources ? `CPU: ${app.resources.cpuPercent.toFixed(1)}%` : 'CPU: —'
    ];
}

function createAppCard(app) {
    const card = document.createElement('article');
    card.className = 'app-card';
    card.dataset.app = app.id;

    const heading = document.createElement('div');
    heading.className = 'app-heading';
    const title = document.createElement('div');
    const name = document.createElement('h3');
    const id = document.createElement('p');
    id.className = 'eyebrow';
    title.append(id, name);
    const status = document.createElement('span');
    status.className = 'status';
    heading.append(title, status);

    const description = document.createElement('p');
    description.className = 'description';
    const autoStartLabel = document.createElement('label');
    autoStartLabel.className = 'auto-start-control';
    const autoStartToggle = document.createElement('input');
    autoStartToggle.type = 'checkbox';
    autoStartToggle.addEventListener('change', () => setAppAutoStart(app.id, autoStartToggle));
    const autoStartText = document.createElement('span');
    autoStartLabel.append(autoStartToggle, autoStartText);
    const metrics = document.createElement('div');
    metrics.className = 'metrics';
    for (const value of appMetricValues(app)) {
        const metric = document.createElement('span');
        metric.textContent = value;
        metrics.appendChild(metric);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
        makeButton('Start', id => runAction(id, 'start'), app.id),
        makeButton('Stop', id => runAction(id, 'stop'), app.id),
        makeButton('Restart', id => runAction(id, 'restart'), app.id),
        makeButton('Logs', showLogs, app.id)
    );
    card.append(heading, description, autoStartLabel, metrics, actions);
    return card;
}

function updateAppCard(card, app) {
    card.querySelector('.app-heading .eyebrow').textContent = app.id;
    card.querySelector('.app-heading h3').textContent = app.name;
    const status = card.querySelector('.status');
    status.className = `status ${app.status}`;
    status.textContent = app.status;
    card.querySelector('.description').textContent = app.description || 'No extra info yet.';
    const autoStartToggle = card.querySelector('.auto-start-control input');
    autoStartToggle.checked = app.autoStart;
    autoStartToggle.setAttribute('aria-label', `Start ${app.name} when Cardinal starts`);
    card.querySelector('.auto-start-control span').textContent = 'Start when Cardinal starts';
    for (const [index, value] of appMetricValues(app).entries()) {
        card.querySelectorAll('.metrics span')[index].textContent = value;
    }
    const [startButton, stopButton, restartButton] = card.querySelectorAll('.actions button');
    startButton.disabled = app.status !== 'stopped' && app.status !== 'errored';
    stopButton.disabled = app.status !== 'running';
    restartButton.disabled = app.status !== 'running';
}

function renderApps(apps) {
    document.getElementById('appCount').textContent = String(apps.length);
    document.getElementById('runningCount').textContent =
        String(apps.filter(app => app.status === 'running').length);
    const existingCards = new Map([...appGrid.children].map(card => [card.dataset.app, card]));
    const cards = apps.map(app => {
        const card = existingCards.get(app.id) || createAppCard(app);
        existingCards.delete(app.id);
        updateAppCard(card, app);
        return card;
    });
    for (const card of existingCards.values()) card.remove();
    if (cards.some((card, index) => appGrid.children[index] !== card) ||
        appGrid.children.length !== cards.length) {
        appGrid.append(...cards);
    }
}

function renderNotifications(notifications) {
    const snapshot = JSON.stringify(notifications);
    document.getElementById('notificationCount').textContent = String(notifications.length);
    if (snapshot === lastNotificationsSnapshot) return;
    lastNotificationsSnapshot = snapshot;
    notificationList.replaceChildren();
    if (notifications.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'notification-empty';
        empty.textContent = 'Nothing here yet. Messages from your apps will show up here.';
        notificationList.appendChild(empty);
        return;
    }
    for (const notification of notifications) {
        const item = document.createElement('article');
        item.className = `notification-item ${notification.level}`;
        const content = document.createElement('div');
        const metadata = document.createElement('p');
        metadata.className = 'notification-meta';
        metadata.textContent =
            `${notification.appName} · ${new Date(notification.createdAt).toLocaleString()}`;
        const title = document.createElement('h3');
        title.textContent = notification.title;
        const message = document.createElement('p');
        message.textContent = notification.message;
        content.append(metadata, title, message);
        const dismiss = document.createElement('button');
        dismiss.className = 'secondary';
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', () => dismissNotification(notification.id));
        item.append(content, dismiss);
        notificationList.appendChild(item);
    }
}

function renderStorage(storage) {
    document.getElementById('storageTotal').textContent = formatBytes(storage.totalBytes);
    document.getElementById('storageDatabase').textContent = formatBytes(storage.databaseBytes);
    document.getElementById('storageCollections').textContent = String(storage.collections);
    const list = document.getElementById('storageApps');
    list.replaceChildren();
    for (const app of storage.apps) {
        const row = document.createElement('article');
        row.className = 'storage-app';
        const identity = document.createElement('div');
        const name = document.createElement('h3');
        name.textContent = app.name;
        const id = document.createElement('p');
        id.textContent = app.id;
        identity.append(name, id);
        const metrics = document.createElement('p');
        metrics.textContent = `${formatBytes(app.bytes)} · ${app.files} files · ${formatBytes(app.databaseBytes)} saved data · ${app.collections} data sets`;
        row.append(identity, metrics);
        list.appendChild(row);
    }
    if (storage.apps.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'notification-empty';
        empty.textContent = 'No app files yet.';
        list.appendChild(empty);
    }
    const refreshedAt = new Date().toLocaleTimeString();
    const status = document.getElementById('storageStatus');
    status.textContent = `Checked at ${refreshedAt}.`;
    status.className = 'settings-status success';
}

async function refreshStorage() {
    const button = document.getElementById('refreshStorageButton');
    const status = document.getElementById('storageStatus');
    button.disabled = true;
    status.textContent = 'Counting files…';
    status.className = 'settings-status';
    try {
        const result = await api('/control/api/v1/storage');
        renderStorage(result.storage);
    } catch (error) {
        status.textContent = error.message;
        status.className = 'settings-status error';
    } finally {
        button.disabled = false;
    }
}

async function loadAppConfig() {
    const appId = appConfigSelect.value;
    if (!appId) throw new Error('Pick an app first.');
    const result = await api(`/control/api/v1/apps/${encodeURIComponent(appId)}/config`);
    appConfigEditor.value = JSON.stringify(result.config, null, 2);
    settingsStatus.textContent = 'Config loaded.';
    settingsStatus.className = 'settings-status success';
}

async function saveAppConfig() {
    const appId = appConfigSelect.value;
    if (!appId) throw new Error('Pick an app first.');
    let config;
    try {
        config = JSON.parse(appConfigEditor.value);
    } catch (error) {
        throw new Error(`Invalid JSON: ${error.message}`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('This config needs to be a JSON object.');
    }
    const result = await api(`/control/api/v1/apps/${encodeURIComponent(appId)}/config`, {
        method: 'PUT',
        body: JSON.stringify({ config })
    });
    settingsStatus.textContent = result.restartRequired
        ? 'Saved. Restart this app for the changes to take effect.'
        : 'Config saved.';
    settingsStatus.className = 'settings-status success';
}

async function exportAppDatabase() {
    const appId = appConfigSelect.value;
    const status = document.getElementById('databaseBackupStatus');
    const button = document.getElementById('exportAppDatabase');
    if (!appId) throw new Error('Pick an app first.');
    button.disabled = true;
    status.textContent = 'Getting your backup ready…';
    status.className = 'settings-status';
    try {
        const result = await api(`/control/api/v1/apps/${encodeURIComponent(appId)}/database/export`);
        const serialized = JSON.stringify(result.backup, null, 2);
        const blob = new Blob([`${serialized}\n`], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `cardinal-${appId}-database-${result.backup.exportedAt.slice(0, 10)}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = `Backup downloaded with ${result.backup.collections.length} data set(s).`;
        status.className = 'settings-status success';
    } catch (error) {
        status.textContent = error.message;
        status.className = 'settings-status error';
    } finally {
        button.disabled = false;
    }
}

async function runDatabaseDoctor(repair) {
    const appId = appConfigSelect.value;
    const status = document.getElementById('databaseDoctorStatus');
    const checkButton = document.getElementById('checkAppDatabase');
    const repairButton = document.getElementById('repairAppDatabase');
    if (!appId) throw new Error('Pick an app first.');
    if (repair && !window.confirm('Try to fix the damaged data? Cardinal will keep the old files as a backup.')) {
        return;
    }

    checkButton.disabled = true;
    repairButton.disabled = true;
    status.textContent = repair ? 'Checking and fixing data…' : 'Checking data…';
    status.className = 'settings-status';
    try {
        const result = await api(`/control/api/v1/apps/${encodeURIComponent(appId)}/database/doctor`, {
            method: 'POST',
            body: JSON.stringify({ repair })
        });
        const { report } = result;
        const { errors, warnings, repaired } = report.summary;
        const outcome = report.healthy
            ? `All good${repaired ? `; fixed ${repaired} problem(s)` : ''}.`
            : `Found ${errors} problem(s) and ${warnings} warning(s).`;
        const issueDetails = report.issues.map(issue => issue.message).join(' ');
        status.textContent = [outcome, issueDetails].filter(Boolean).join(' ');
        status.className = report.healthy ? 'settings-status success' : 'settings-status error';
    } finally {
        checkButton.disabled = false;
        repairButton.disabled = false;
    }
}

function renderApiRoutes(container, routes, basePath = '') {
    container.replaceChildren();
    for (const route of routes) {
        const row = document.createElement('article');
        row.className = 'api-route';
        const signature = document.createElement('div');
        signature.className = 'api-signature';
        const method = document.createElement('span');
        method.className = `api-method ${route.method.toLowerCase()}`;
        method.textContent = route.method;
        const path = document.createElement('code');
        path.textContent = `${basePath}${route.path === '/' ? '' : route.path}`;
        signature.append(method, path);
        const description = document.createElement('p');
        description.textContent = route.description;
        row.append(signature, description);
        container.appendChild(row);
    }
}

async function loadApiReference() {
    const result = await api('/control/api/v1');
    const { api: apiInfo } = result;
    document.getElementById('managementApiBase').textContent = apiInfo.basePath;
    document.getElementById('managementApiAuth').textContent =
        `Log in first. ${apiInfo.authentication}`;
    renderApiRoutes(document.getElementById('managementApiRoutes'), apiInfo.routes, apiInfo.basePath);
    document.getElementById('appApiAccess').textContent = apiInfo.appApi.access;
    renderApiRoutes(document.getElementById('appApiRoutes'), apiInfo.appApi.routes, '/v1');
}

async function loadCardinalSettings() {
    const result = await api('/control/api/v1/settings');
    document.getElementById('listenHost').value = result.settings.listenHost;
    document.getElementById('listenPort').value = result.settings.port;
    document.getElementById('adminUsername').value = result.settings.auth.username;
    cardinalSettingsStatus.textContent = result.settings.auth.passwordConfigured
        ? 'Password is set.'
        : 'Set a password before letting anyone else use this page.';
}

async function saveCardinalSettings(event) {
    event.preventDefault();
    const passwordInput = document.getElementById('adminPassword');
    const auth = { username: document.getElementById('adminUsername').value };
    if (passwordInput.value) auth.password = passwordInput.value;
    const result = await api('/control/api/v1/settings', {
        method: 'PUT',
        body: JSON.stringify({
            settings: {
                listenHost: document.getElementById('listenHost').value,
                port: Number(document.getElementById('listenPort').value),
                auth
            }
        })
    });
    passwordInput.value = '';
    if (result.reauthenticate) {
        location.href = '/control/login';
        return;
    }
    cardinalSettingsStatus.textContent = result.restartRequired
        ? 'Saved. Restart Cardinal to use the new address or port.'
        : 'Login saved.';
    cardinalSettingsStatus.className = 'settings-status success';
}

async function refreshDashboard() {
    pageError.textContent = '';
    const [appsResult, notificationsResult] = await Promise.all([
        api('/control/api/v1/apps'),
        api('/control/api/v1/notifications')
    ]);
    renderApps(appsResult.apps);
    renderSettingsApps(appsResult.apps);
    renderNotifications(notificationsResult.notifications);
}

async function runAction(appId, action) {
    try {
        await api(`/control/api/v1/apps/${encodeURIComponent(appId)}/actions/${action}`, { method: 'POST' });
        await refreshDashboard();
    } catch (error) {
        pageError.textContent = error.message;
    }
}

async function setAppAutoStart(appId, toggle) {
    toggle.disabled = true;
    pageError.textContent = '';
    try {
        await api(`/control/api/v1/apps/${encodeURIComponent(appId)}/auto-start`, {
            method: 'PUT',
            body: JSON.stringify({ enabled: toggle.checked })
        });
        await refreshDashboard();
    } catch (error) {
        toggle.checked = !toggle.checked;
        pageError.textContent = error.message;
    } finally {
        toggle.disabled = false;
    }
}

async function dismissNotification(id) {
    try {
        await api(`/control/api/v1/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refreshDashboard();
    } catch (error) {
        pageError.textContent = error.message;
    }
}

document.getElementById('refreshButton').addEventListener('click', () =>
    refreshDashboard().catch(error => { pageError.textContent = error.message; })
);
document.getElementById('refreshStorageButton').addEventListener('click', refreshStorage);
document.getElementById('logoutButton').addEventListener('click', async () => {
    try {
        await api('/control/logout', { method: 'POST' });
        location.href = '/control/login';
    } catch (error) {
        pageError.textContent = error.message;
    }
});
document.getElementById('closeDialog').addEventListener('click', () => detailsDialog.close());
document.getElementById('refreshLogs').addEventListener('click', () => refreshLogs(true));
liveLogsButton.addEventListener('click', () => {
    const shouldStart = liveLogsButton.getAttribute('aria-pressed') !== 'true';
    if (!shouldStart) {
        stopLiveLogUpdates();
        logStatus.textContent = 'Updates paused.';
        logStatus.className = 'settings-status';
        return;
    }
    liveLogsButton.setAttribute('aria-pressed', 'true');
    liveLogsButton.textContent = 'Pause updates';
    void refreshLogs(true).finally(() => {
        if (liveLogsButton.getAttribute('aria-pressed') === 'true' && detailsDialog.open) {
            scheduleLiveLogRefresh();
        }
    });
});
document.getElementById('loadAppConfig').addEventListener('click', () =>
    loadAppConfig().catch(error => {
        settingsStatus.textContent = error.message;
        settingsStatus.className = 'settings-status error';
    })
);
document.getElementById('saveAppConfig').addEventListener('click', () =>
    saveAppConfig().catch(error => {
        settingsStatus.textContent = error.message;
        settingsStatus.className = 'settings-status error';
    })
);
document.getElementById('exportAppDatabase').addEventListener('click', () =>
    exportAppDatabase().catch(error => {
        const status = document.getElementById('databaseBackupStatus');
        status.textContent = error.message;
        status.className = 'settings-status error';
    })
);
document.getElementById('checkAppDatabase').addEventListener('click', () =>
    runDatabaseDoctor(false).catch(error => {
        const status = document.getElementById('databaseDoctorStatus');
        status.textContent = error.message;
        status.className = 'settings-status error';
    })
);
document.getElementById('repairAppDatabase').addEventListener('click', () =>
    runDatabaseDoctor(true).catch(error => {
        const status = document.getElementById('databaseDoctorStatus');
        status.textContent = error.message;
        status.className = 'settings-status error';
    })
);
document.getElementById('cardinalSettingsForm').addEventListener('submit', event =>
    saveCardinalSettings(event).catch(error => {
        cardinalSettingsStatus.textContent = error.message;
        cardinalSettingsStatus.className = 'settings-status error';
    })
);
appConfigSelect.addEventListener('change', () => {
    appConfigEditor.value = '';
    settingsStatus.textContent = '';
    settingsStatus.className = 'settings-status';
    const doctorStatus = document.getElementById('databaseDoctorStatus');
    doctorStatus.textContent = '';
    doctorStatus.className = 'settings-status';
});
document.getElementById('detailsDialog').addEventListener('click', event => {
    if (event.target === detailsDialog) detailsDialog.close();
});
detailsDialog.addEventListener('close', () => {
    stopLiveLogUpdates();
    currentLogAppId = null;
    logRequestVersion += 1;
});

refreshDashboard().catch(error => { pageError.textContent = error.message; });
loadApiReference().catch(error => {
    apiStatus.textContent = error.message;
    apiStatus.className = 'settings-status error';
});
loadCardinalSettings().catch(error => {
    cardinalSettingsStatus.textContent = error.message;
    cardinalSettingsStatus.className = 'settings-status error';
});
refreshStorage();
setInterval(() => refreshDashboard().catch(error => { pageError.textContent = error.message; }), 10000);
