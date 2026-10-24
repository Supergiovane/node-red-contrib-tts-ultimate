'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const safePath = require('../ttsultimate/lib/safe-path');

const folder = path.join(path.sep, 'data', 'sonospollyttsstorage', 'hailingpermanentfiles');

test('uploadPath keeps plain names inside the folder', () => {
    assert.equal(safePath.uploadPath(folder, 'Hailing_', 'ding dong.mp3', '.mp3'), path.join(folder, 'Hailing_ding dong.mp3'));
    assert.equal(safePath.uploadPath(folder, 'Hailing_', 'DING.MP3', '.mp3'), path.join(folder, 'Hailing_DING.MP3'));
});

test('uploadPath strips directories from client-supplied names', () => {
    assert.equal(safePath.uploadPath(folder, 'Hailing_', '/../../../nodes/evil.mp3', '.mp3'), path.join(folder, 'Hailing_evil.mp3'));
    assert.equal(safePath.uploadPath(folder, 'Hailing_', '..\\..\\evil.mp3', '.mp3'), path.join(folder, 'Hailing_evil.mp3'));
});

test('uploadPath rejects wrong extensions and unusable names', () => {
    assert.equal(safePath.uploadPath(folder, 'Hailing_', 'evil.mp3.js', '.mp3'), null);
    assert.equal(safePath.uploadPath(folder, 'Hailing_', 'evil.mp3\0.mp3', '.mp3'), null);
    assert.equal(safePath.uploadPath(folder, 'Hailing_', '../', '.mp3'), null);
    assert.equal(safePath.uploadPath(folder, 'Hailing_', '', '.mp3'), null);
    assert.equal(safePath.uploadPath(folder, 'Hailing_', undefined, '.mp3'), null);
});

test('existingFilePath accepts only bare prefixed names', () => {
    assert.equal(safePath.existingFilePath(folder, 'Hailing_', 'Hailing_ding.mp3', '.mp3'), path.join(folder, 'Hailing_ding.mp3'));
    assert.equal(safePath.existingFilePath(folder, 'Hailing_', '../../flows.json', '.mp3'), null);
    assert.equal(safePath.existingFilePath(folder, 'Hailing_', 'Hailing_../../x.mp3', '.mp3'), null);
    assert.equal(safePath.existingFilePath(folder, 'Hailing_', 'other.mp3', '.mp3'), null);
    assert.equal(safePath.existingFilePath(folder, 'Hailing_', 'Hailing_ding.txt', '.mp3'), null);
    assert.equal(safePath.existingFilePath(folder, 'Hailing_', ['Hailing_ding.mp3'], '.mp3'), null);
});

// Builds a ttsultimate-config node against a fake RED that records the admin routes.
function createConfigNode(t) {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsultimate-safe-path-'));
    const routes = {};
    const closeHandlers = [];
    let ConfigConstructor;
    const register = (method) => (route, ...handlers) => { routes[method + ' ' + route] = handlers; };
    const RED = {
        settings: { userDir },
        log: { error() {}, info() {}, warn() {} },
        auth: { needsPermission: (permission) => Object.assign((req, res, next) => next(), { permission }) },
        httpAdmin: { get: register('GET'), post: register('POST') },
        nodes: {
            createNode(node) {
                const emitter = new EventEmitter();
                node.id = 'safe-path-config';
                node.on = (event, handler) => { if (event === 'close') closeHandlers.push(handler); emitter.on(event, handler); };
                node.credentials = {};
            },
            registerType(name, constructor) {
                if (name === 'ttsultimate-config') ConfigConstructor = constructor;
            }
        }
    };
    const configPath = require.resolve('../ttsultimate/ttsultimate-config');
    delete require.cache[configPath];
    require(configPath)(RED);
    const node = new ConfigConstructor({ noderedipaddress: '127.0.0.1', noderedport: '0', ttsservice: 'googletranslate', TTSRootFolderPath: '' });
    t.after(async () => {
        for (const handler of closeHandlers) await new Promise((resolve) => handler.length > 0 ? handler(resolve) : (handler(), resolve()));
        if (node.oWebserver) node.oWebserver.close();
        fs.rmSync(userDir, { recursive: true, force: true });
    });
    return { node, routes, userDir };
}

// Sends a multipart upload to the route handler (the last one, after the permission middleware).
function upload(handlers, field, fileName) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const fakeRes = { json: (body) => { res.end(); server.close(); resolve(body); } };
            handlers[handlers.length - 1](req, fakeRes);
        });
        server.listen(0, '127.0.0.1', () => {
            const boundary = 'ttsultimateboundary';
            const body = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: audio/mpeg\r\n\r\nfake\r\n--${boundary}--\r\n`;
            const req = http.request({ port: server.address().port, host: '127.0.0.1', method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } }, (r) => r.resume());
            req.on('error', reject);
            req.end(body);
        });
    });
}

test('file upload and delete admin routes require write permission', (t) => {
    const { routes } = createConfigNode(t);
    for (const route of ['POST /ttsultimateHailing', 'POST /ttsultimatesavegooglecredentialsfile', 'POST /ttsultimateOwnFile', 'GET /deleteHailingFile', 'GET /deleteOwnFile']) {
        assert.ok(routes[route], route + ' is registered');
        assert.equal(routes[route].length, 2, route + ' has a permission middleware');
        assert.equal(routes[route][0].permission, 'TTSConfigNode.write', route + ' requires write permission');
    }
});

test('hailing upload cannot write outside the hailing folder', async (t) => {
    const { node, routes, userDir } = createConfigNode(t);
    const result = await upload(routes['POST /ttsultimateHailing'], 'customHailing', '/../../../nodes/evil.mp3');
    assert.equal(result.status, 220);
    assert.equal(fs.existsSync(path.join(userDir, 'nodes', 'evil.mp3')), false);
    assert.equal(fs.existsSync(path.join(node.TTSRootFolderPath, 'hailingpermanentfiles', 'Hailing_evil.mp3')), true);

    const rejected = await upload(routes['POST /ttsultimateHailing'], 'customHailing', 'evil.mp3.js');
    assert.equal(rejected.status, 404);
    assert.equal(fs.existsSync(path.join(node.TTSRootFolderPath, 'hailingpermanentfiles', 'Hailing_evil.mp3.js')), false);
});

test('own file upload cannot write outside the own files folder', async (t) => {
    const { node, routes, userDir } = createConfigNode(t);
    const result = await upload(routes['POST /ttsultimateOwnFile'], 'customTTS', '/../../../nodes/evil.mp3');
    assert.equal(result.status, 220);
    assert.equal(fs.existsSync(path.join(userDir, 'nodes', 'evil.mp3')), false);
    assert.equal(fs.existsSync(path.join(node.TTSRootFolderPath, 'ttspermanentfiles', 'OwnFile_evil.mp3')), true);
});

test('delete routes ignore names that point outside their folder', (t) => {
    const { node, routes, userDir } = createConfigNode(t);
    const victim = path.join(userDir, 'flows.mp3');
    fs.writeFileSync(victim, 'keep me');
    const kept = path.join(node.TTSRootFolderPath, 'hailingpermanentfiles', 'Hailing_ding.mp3');
    fs.writeFileSync(kept, 'delete me');
    const res = { json() {} };
    const deleteHailing = routes['GET /deleteHailingFile'][1];
    const deleteOwnFile = routes['GET /deleteOwnFile'][1];

    deleteHailing({ query: { FileName: '../../flows.mp3' } }, res);
    deleteOwnFile({ query: { FileName: '../../flows.mp3' } }, res);
    assert.equal(fs.existsSync(victim), true);

    deleteHailing({ query: { FileName: 'Hailing_ding.mp3' } }, res);
    assert.equal(fs.existsSync(kept), false);
});
