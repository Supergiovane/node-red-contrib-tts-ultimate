'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { CastClient, encodeMessage, decodeMessage, DEFAULT_MEDIA_RECEIVER_APP_ID } = require('../ttsultimate/lib/googlecast-player');

test('CastMessage encoding round-trips', () => {
    const message = { sourceId: 'sender-0', destinationId: 'receiver-0', namespace: 'urn:x-cast:com.google.cast.receiver', payload: JSON.stringify({ type: 'LAUNCH', text: 'è'.repeat(100) }) };
    const decoded = decodeMessage(encodeMessage(message));
    assert.deepEqual(decoded, Object.assign({ protocolVersion: 0, payloadType: 0 }, message));
});

test('CastMessage encoding matches the protobuf wire format', () => {
    const bytes = encodeMessage({ sourceId: 's', destinationId: 'd', namespace: 'n', payload: '{}' });
    assert.deepEqual([...bytes], [0x08, 0x00, 0x12, 0x01, 0x73, 0x1a, 0x01, 0x64, 0x22, 0x01, 0x6e, 0x28, 0x00, 0x32, 0x02, 0x7b, 0x7d]);
});

// A fake Chromecast speaking the CASTV2 framing over plain TCP.
function fakeCastDevice(t, behaviour) {
    const received = [];
    const server = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);
        const send = (sourceId, destinationId, namespace, data) => {
            const body = encodeMessage({ sourceId, destinationId, namespace, payload: JSON.stringify(data) });
            const header = Buffer.alloc(4);
            header.writeUInt32BE(body.length, 0);
            // Split the frame in two writes to exercise the client's reassembly.
            socket.write(Buffer.concat([header, body.subarray(0, 3)]));
            socket.write(body.subarray(3));
        };
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
                const message = decodeMessage(buffer.subarray(4, 4 + buffer.readUInt32BE(0)));
                buffer = buffer.subarray(4 + buffer.readUInt32BE(0));
                const data = JSON.parse(message.payload);
                received.push({ destinationId: message.destinationId, namespace: message.namespace, data });
                behaviour(data, message, send, socket);
            }
        });
        socket.on('error', () => { });
    });
    t.after(() => server.close());
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, received })));
}

const plainConnect = (host, port, onConnect) => net.connect({ host, port }, onConnect);

function chromecast(options) {
    const opts = options || {};
    return (data, message, send) => {
        const reply = (namespace, payload) => send(message.destinationId, message.sourceId, namespace, Object.assign({ requestId: data.requestId }, payload));
        if (data.type === 'LAUNCH') {
            reply('urn:x-cast:com.google.cast.receiver', {
                type: 'RECEIVER_STATUS',
                status: { applications: [{ appId: DEFAULT_MEDIA_RECEIVER_APP_ID, transportId: 'transport-7', sessionId: 'session-7' }] }
            });
        } else if (data.type === 'SET_VOLUME') {
            reply('urn:x-cast:com.google.cast.receiver', { type: 'RECEIVER_STATUS', status: {} });
        } else if (data.type === 'LOAD') {
            if (opts.loadFails) {
                reply('urn:x-cast:com.google.cast.media', { type: 'LOAD_FAILED' });
                return;
            }
            reply('urn:x-cast:com.google.cast.media', { type: 'MEDIA_STATUS', status: [{ playerState: 'BUFFERING' }] });
            const broadcast = (state) => send('transport-7', '*', 'urn:x-cast:com.google.cast.media', { type: 'MEDIA_STATUS', requestId: 0, status: [{ playerState: state }] });
            setTimeout(() => broadcast('PLAYING'), 10);
            setTimeout(() => broadcast('IDLE'), 20);
        }
    };
}

test('plays a URL on the Default Media Receiver and reports status until IDLE', async (t) => {
    const device = await fakeCastDevice(t, chromecast());
    const client = new CastClient({ connect: plainConnect });
    t.after(() => client.close());
    const states = [];
    const finished = new Promise((resolve) => client.on('status', (status) => {
        states.push(status.playerState);
        if (status.playerState === 'IDLE') resolve();
    }));

    await client.connect('127.0.0.1', device.port);
    await client.setVolume(0.4);
    const app = await client.launchDefaultMediaReceiver();
    assert.deepEqual(app, { transportId: 'transport-7', sessionId: 'session-7' });
    await client.load(app, { contentId: 'http://127.0.0.1:1980/tts?f=a.mp3', contentType: 'audio/mpeg', streamType: 'BUFFERED' });
    await finished;

    assert.deepEqual(states, ['BUFFERING', 'PLAYING', 'IDLE']);
    const summary = device.received.map((m) => m.destinationId + ' ' + m.data.type);
    assert.deepEqual(summary, ['receiver-0 CONNECT', 'receiver-0 SET_VOLUME', 'receiver-0 LAUNCH', 'transport-7 CONNECT', 'transport-7 LOAD']);
    const load = device.received.find((m) => m.data.type === 'LOAD');
    assert.equal(load.namespace, 'urn:x-cast:com.google.cast.media');
    assert.equal(load.data.sessionId, 'session-7');
    assert.equal(load.data.autoplay, true);
    assert.equal(load.data.media.contentId, 'http://127.0.0.1:1980/tts?f=a.mp3');
    assert.deepEqual(device.received[1].data.volume, { level: 0.4 });
});

test('answers heartbeat PINGs with PONG', async (t) => {
    let pong;
    const gotPong = new Promise((resolve) => { pong = resolve; });
    const device = await fakeCastDevice(t, (data, message, send) => {
        if (data.type === 'CONNECT') send('receiver-0', 'sender-0', 'urn:x-cast:com.google.cast.tp.heartbeat', { type: 'PING' });
        if (data.type === 'PONG') pong(message.namespace);
    });
    const client = new CastClient({ connect: plainConnect });
    t.after(() => client.close());
    await client.connect('127.0.0.1', device.port);
    assert.equal(await gotPong, 'urn:x-cast:com.google.cast.tp.heartbeat');
});

test('rejects when the receiver refuses to load the media', async (t) => {
    const device = await fakeCastDevice(t, chromecast({ loadFails: true }));
    const client = new CastClient({ connect: plainConnect });
    t.after(() => client.close());
    await client.connect('127.0.0.1', device.port);
    const app = await client.launchDefaultMediaReceiver();
    await assert.rejects(client.load(app, { contentId: 'x', contentType: 'audio/mpeg', streamType: 'BUFFERED' }), /load failed \(LOAD_FAILED\)/);
});

test('emits an error when the device drops the connection', async (t) => {
    const device = await fakeCastDevice(t, (data, message, send, socket) => {
        if (data.type === 'LAUNCH') socket.destroy();
    });
    const client = new CastClient({ connect: plainConnect });
    t.after(() => client.close());
    const errored = new Promise((resolve) => client.on('error', resolve));
    await client.connect('127.0.0.1', device.port);
    const launch = client.launchDefaultMediaReceiver();
    assert.match((await errored).message, /connection closed by the device/);
    await assert.rejects(launch, /client closed/);
});

test('rejects connect when nothing listens on the port', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const client = new CastClient({ connect: plainConnect });
    await assert.rejects(client.connect('127.0.0.1', port), /ECONNREFUSED/);
    client.close();
});
