function getLoopbackApiUrl(value, endpoint) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Cardinal API URL must be a valid absolute URL.');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname) ||
        url.username || url.password || url.search || url.hash) {
        throw new Error('Cardinal app API must use HTTP on a loopback address.');
    }
    return new URL(`${url.pathname.replace(/\/+$/, '')}/${endpoint}`, url.origin);
}

function createCardinalClient(options = {}) {
    const apiUrl = options.apiUrl || process.env.CARDINAL_API_URL;
    const token = options.token || process.env.CARDINAL_API_TOKEN;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (!apiUrl) throw new Error('This app was not given a Cardinal API URL.');
    if (!token) throw new Error('This app was not given a Cardinal API token.');
    if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable in this Node.js runtime.');

    async function request(endpoint, requestOptions = {}) {
        const headers = {
            Authorization: `Bearer ${token}`,
            ...requestOptions.headers
        };
        const init = { ...requestOptions, headers };
        if (requestOptions.body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetchImpl(getLoopbackApiUrl(apiUrl, endpoint), init);
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.message || `Cardinal API request failed (${response.status}).`);
        }
        return result;
    }

    return {
        getApp: async () => (await request('app')).app,
        getConfig: async () => (await request('app/config')).config,
        updateConfig: async config => request('app/config', {
            method: 'PUT',
            body: JSON.stringify({ config })
        }),
        notify: async notification => (await request('notifications', {
            method: 'POST',
            body: JSON.stringify(notification)
        })).notification
    };
}

async function notifyCardinal(notification, options = {}) {
    return createCardinalClient(options).notify(notification);
}

module.exports = { createCardinalClient, notifyCardinal };
