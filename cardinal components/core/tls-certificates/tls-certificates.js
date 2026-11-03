const fs = require('node:fs');
const path = require('node:path');
const selfsigned = require('selfsigned');

async function ensureSelfSignedCertificate(directory) {
    fs.mkdirSync(directory, { recursive: true });
    const keyPath = path.join(directory, 'cardinal-private.key');
    const certPath = path.join(directory, 'cardinal-certificate.crt');
    const hasKey = fs.existsSync(keyPath);
    const hasCert = fs.existsSync(certPath);
    if (hasKey !== hasCert) {
        throw new Error(`Cardinal TLS certificate is incomplete in ${directory}; restore both certificate files or remove the remaining file.`);
    }
    if (hasKey) {
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }

    const pems = await selfsigned.generate(
        [{ name: 'commonName', value: 'localhost' }],
        {
            days: 365,
            extensions: [{
                name: 'subjectAltName',
                altNames: [
                    { type: 2, value: 'localhost' },
                    { type: 7, ip: '127.0.0.1' },
                    { type: 7, ip: '::1' }
                ]
            }]
        }
    );
    const key = pems.private || pems.privateKey;
    const cert = pems.cert || pems.certificate;
    if (!key || !cert) throw new Error('Cardinal could not generate a complete TLS certificate.');

    const keyTemp = `${keyPath}.tmp`;
    const certTemp = `${certPath}.tmp`;
    try {
        fs.writeFileSync(keyTemp, key, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(certTemp, cert, { flag: 'wx', mode: 0o644 });
        fs.renameSync(keyTemp, keyPath);
        fs.renameSync(certTemp, certPath);
    } catch (error) {
        for (const temporaryPath of [keyTemp, certTemp]) {
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }
        throw error;
    }
    return { key, cert };
}

module.exports = { ensureSelfSignedCertificate };
