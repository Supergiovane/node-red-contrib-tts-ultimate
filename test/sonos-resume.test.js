'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');

const sonosModule = require('../ttsultimate/lib/sonos-player');
const { parseXml } = require('../ttsultimate/lib/xml-to-object');
const { takeSnapshot, restoreSnapshot, sourceOf, SOURCE } = require('../ttsultimate/lib/sonos-snapshot');

const ANNOUNCEMENT = 'http://192.168.1.5:1980/tts/tts.mp3?f=%2Fdata%2Fhello.mp3';
const QUEUE_URI = 'x-rincon-queue:RINCON_000E58AABBCC01400#0';
const RADIO_URI = 'x-sonosapi-stream:s24896?sid=254&flags=8224&sn=0';
const RADIO_META = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="F00092020s24896" parentID="L" restricted="true"><dc:title>Radio Deejay</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON65031_</desc></item></DIDL-Lite>';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A stateful fake Sonos player: it keeps the transport source, queue position, play mode and state,
// and plays an announcement for clipMs before stopping on its own, like a real speaker.
function fakeSonos(t, initial, options) {
    const opts = options || {};
    const state = Object.assign({
        uri: '', metadata: '', transport: 'STOPPED', track: 0, relTime: '0:00:00', playMode: 'NORMAL',
        volume: 20, mute: 0, queueLength: 10, actions: []
    }, initial);
    const isQueue = () => state.uri.startsWith('x-rincon-queue:');
    const answers = {
        GetMediaInfo: () => ({ NrTracks: isQueue() ? state.queueLength : 1, CurrentURI: state.uri, CurrentURIMetaData: state.metadata }),
        GetTransportInfo: () => ({ CurrentTransportState: state.transport, CurrentTransportStatus: 'OK', CurrentSpeed: 1 }),
        GetPositionInfo: () => ({ Track: state.track, TrackDuration: isQueue() ? '0:04:00' : '0:00:00', TrackMetaData: '', TrackURI: state.trackUri || state.uri, RelTime: state.relTime }),
        GetTransportSettings: () => ({ PlayMode: state.playMode, RecQualityMode: 'NOT_IMPLEMENTED' }),
        SetPlayMode: (args) => { state.playMode = args.NewPlayMode; },
        SetAVTransportURI: (args) => {
            state.uri = args.CurrentURI; state.metadata = args.CurrentURIMetaData;
            state.transport = 'STOPPED'; state.track = isQueue() ? 1 : 1; state.relTime = '0:00:00'; state.trackUri = undefined;
        },
        Play: () => {
            if (!state.uri) throw new Error('701');
            if (state.uri.startsWith('x-rincon:')) throw new Error('800'); // a group member can't play by itself
            state.transport = 'PLAYING';
            if (!isQueue() && state.uri === opts.announcement) setTimeout(() => { state.transport = 'STOPPED'; }, opts.clipMs || 100);
        },
        Stop: () => { state.transport = 'STOPPED'; },
        Seek: (args) => {
            if (!isQueue()) throw new Error('701');
            if (args.Unit === 'TRACK_NR') { state.track = Number(args.Target); state.relTime = '0:00:00'; } else state.relTime = args.Target;
        },
        AddURIToQueue: () => { state.queueLength++; return { FirstTrackNumberEnqueued: state.queueLength, NumTracksAdded: 1, NewQueueLength: state.queueLength }; },
        BecomeCoordinatorOfStandaloneGroup: () => { if (state.uri.startsWith('x-rincon:')) { state.uri = ''; state.metadata = ''; } },
        GetVolume: () => ({ CurrentVolume: state.volume }),
        SetVolume: (args) => { state.volume = Number(args.DesiredVolume); },
        GetMute: () => ({ CurrentMute: state.mute }),
        SetMute: (args) => { state.mute = Number(args.DesiredMute); },
        GetZoneAttributes: () => ({ CurrentZoneName: 'Kitchen' }),
        GetZoneInfo: () => ({ MACAddress: '00:0E:58:AA:BB:CC' })
    };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const action = /#(\w+)"$/.exec(req.headers.soapaction)[1];
            const service = /service:(\w+):1/.exec(req.headers.soapaction)[1];
            const envelope = parseXml(body)['s:Envelope']['s:Body']['u:' + action];
            const args = typeof envelope === 'object' ? envelope : {};
            state.actions.push(action === 'Seek' ? action + ' ' + args.Unit + ' ' + args.Target : action);
            let out;
            try {
                if (!answers[action]) throw new Error('401');
                out = answers[action](args) || {};
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/xml' });
                return res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${error.message}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
            }
            const inner = Object.entries(out).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${inner}</u:${action}Response></s:Body></s:Envelope>`);
        });
    });
    t.after(() => server.close());
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, port: server.address().port })));
}

// Snapshot -> play an announcement until it stops -> restore, like HandleQueue does.
async function announce(sonos, fake) {
    const snapshot = await takeSnapshot(sonos);
    await sonos.stop();
    await sonos.setAVTransportURI(ANNOUNCEMENT);
    while (fake.state.transport !== 'STOPPED') await new Promise((resolve) => setTimeout(resolve, 10));
    fake.state.actions.length = 0;
    const result = await restoreSnapshot(sonos, snapshot, { stepDelayMs: 0 });
    return { snapshot, result };
}

test('sourceOf classifies transport URIs', () => {
    assert.equal(sourceOf(''), SOURCE.NONE);
    assert.equal(sourceOf(QUEUE_URI), SOURCE.QUEUE);
    assert.equal(sourceOf('x-rincon:RINCON_1'), SOURCE.GROUP_MEMBER);
    assert.equal(sourceOf('x-sonos-vli:RINCON_1:1,spotify:abc'), SOURCE.REMOTE_SESSION);
    assert.equal(sourceOf(ANNOUNCEMENT), SOURCE.ANNOUNCEMENT);
    assert.equal(sourceOf(RADIO_URI), SOURCE.URI);
    assert.equal(sourceOf('x-sonos-htastream:RINCON_1:spdif'), SOURCE.URI);
});

test('a playing music queue resumes at the same track, position and play mode', async (t) => {
    const fake = await fakeSonos(t, { uri: QUEUE_URI, transport: 'PLAYING', track: 5, relTime: '0:02:10', playMode: 'SHUFFLE' }, { announcement: ANNOUNCEMENT });
    const { result } = await announce(new sonosModule.Sonos('127.0.0.1', fake.port), fake);
    assert.equal(result, 'queue resumed');
    assert.deepEqual(
        { uri: fake.state.uri, track: fake.state.track, relTime: fake.state.relTime, playMode: fake.state.playMode, transport: fake.state.transport, queueLength: fake.state.queueLength },
        { uri: QUEUE_URI, track: 5, relTime: '0:02:10', playMode: 'SHUFFLE', transport: 'PLAYING', queueLength: 10 }
    );
    assert.deepEqual(fake.state.actions, ['SetAVTransportURI', 'SetPlayMode', 'Seek TRACK_NR 5', 'Seek REL_TIME 0:02:10', 'Play']);
});

test('a queue of Spotify tracks is resumed as a queue, not re-enqueued', async (t) => {
    // Before, the x-sonos-spotify track uri made it look like a stream and it was added to the queue again.
    const fake = await fakeSonos(t, { uri: QUEUE_URI, trackUri: 'x-sonos-spotify:spotify%3atrack%3a4LI1?sid=9&flags=8224&sn=1', transport: 'PLAYING', track: 2, relTime: '0:00:40' }, { announcement: ANNOUNCEMENT });
    await announce(new sonosModule.Sonos('127.0.0.1', fake.port), fake);
    assert.equal(fake.state.uri, QUEUE_URI);
    assert.equal(fake.state.track, 2);
    assert.equal(fake.state.queueLength, 10);
    assert.equal(fake.state.actions.includes('AddURIToQueue'), false);
});

test('a paused queue gets its position back but stays paused', async (t) => {
    const fake = await fakeSonos(t, { uri: QUEUE_URI, transport: 'PAUSED_PLAYBACK', track: 3, relTime: '0:01:00' }, { announcement: ANNOUNCEMENT });
    const { result } = await announce(new sonosModule.Sonos('127.0.0.1', fake.port), fake);
    assert.equal(result, 'queue restored (paused)');
    assert.deepEqual([fake.state.uri, fake.state.track, fake.state.relTime, fake.state.transport], [QUEUE_URI, 3, '0:01:00', 'STOPPED']);
});

test('a radio station resumes with its own metadata and does not touch the queue', async (t) => {
    const fake = await fakeSonos(t, { uri: RADIO_URI, metadata: RADIO_META, transport: 'PLAYING', track: 1 }, { announcement: ANNOUNCEMENT });
    const { result } = await announce(new sonosModule.Sonos('127.0.0.1', fake.port), fake);
    assert.equal(result, 'source resumed');
    assert.deepEqual([fake.state.uri, fake.state.metadata, fake.state.transport, fake.state.queueLength], [RADIO_URI, RADIO_META, 'PLAYING', 10]);
    assert.deepEqual(fake.state.actions, ['SetAVTransportURI', 'Play']);
});

test('TV / line-in sources are restored', async (t) => {
    const fake = await fakeSonos(t, { uri: 'x-sonos-htastream:RINCON_000E58AABBCC01400:spdif', transport: 'PLAYING' }, { announcement: ANNOUNCEMENT });
    await announce(new sonosModule.Sonos('127.0.0.1', fake.port), fake);
    assert.deepEqual([fake.state.uri, fake.state.transport], ['x-sonos-htastream:RINCON_000E58AABBCC01400:spdif', 'PLAYING']);
});

test('a group member rejoins its coordinator without trying to play', async (t) => {
    const fake = await fakeSonos(t, { uri: 'x-rincon:RINCON_COORDINATOR01400', transport: 'PLAYING' }, { announcement: ANNOUNCEMENT });
    const { result } = await announce(new sonosModule.Sonos('127.0.0.1', fake.port), fake);
    assert.equal(result, 'group rejoined');
    assert.equal(fake.state.uri, 'x-rincon:RINCON_COORDINATOR01400');
    assert.deepEqual(fake.state.actions, ['SetAVTransportURI']);
});

test('nothing is restored for an empty player, a previous announcement or Spotify Connect', async (t) => {
    for (const [uri, expected] of [['', 'nothing to resume'], [ANNOUNCEMENT, 'nothing to resume'], ['x-sonos-vli:RINCON_1:1,spotify:abc', "Spotify Connect / AirPlay sessions can't be resumed"]]) {
        const fake = await fakeSonos(t, { uri, transport: 'STOPPED' });
        const snapshot = await takeSnapshot(new sonosModule.Sonos('127.0.0.1', fake.port));
        fake.state.actions.length = 0;
        assert.equal(await restoreSnapshot(new sonosModule.Sonos('127.0.0.1', fake.port), snapshot, { stepDelayMs: 0 }), expected);
        assert.deepEqual(fake.state.actions, []);
    }
});

test('restore errors are reported instead of being swallowed', async (t) => {
    const fake = await fakeSonos(t, { uri: QUEUE_URI, transport: 'PLAYING', track: 5 });
    const sonos = new sonosModule.Sonos('127.0.0.1', fake.port);
    const snapshot = await takeSnapshot(sonos);
    fake.state.uri = RADIO_URI;
    snapshot.uri = 'x-rincon-queue:BROKEN'; // the device refuses to seek outside a queue
    const original = sonos.setAVTransportURI.bind(sonos);
    sonos.setAVTransportURI = async () => true; // pretend the source change was ignored
    await assert.rejects(restoreSnapshot(sonos, snapshot, { stepDelayMs: 0 }), /upnpErrorCode/);
    sonos.setAVTransportURI = original;
});

// End to end: the real TTS-Ultimate node plays an announcement on the fake Sonos and resumes the queue.
test('TTS-Ultimate resumes the playing queue after an announcement', { timeout: 30000 }, async (t) => {
    const announcement = 'http://example.test/ding.mp3';
    const fake = await fakeSonos(t, { uri: QUEUE_URI, transport: 'PLAYING', track: 4, relTime: '0:01:30', playMode: 'REPEAT_ALL', volume: 22 }, { announcement, clipMs: 200 });

    const OriginalSonos = sonosModule.Sonos;
    sonosModule.Sonos = class extends OriginalSonos { constructor(host) { super(host, fake.port); } };
    const runtimePath = require.resolve('../ttsultimate/ttsultimate');
    delete require.cache[runtimePath];

    const sent = [];
    let NodeConstructor;
    const server = { TTSRootFolderPath: '/tmp/ttsultimate-resume-test', ttsCacheFolder: '/tmp/ttsultimate-resume-test/cache', sNoderedURL: 'http://127.0.0.1:1880', whoIsUsingTheServer: '', ttsservice: 'googletranslate' };
    const RED = {
        settings: { userDir: '/tmp/ttsultimate-resume-test' },
        log: { error() {}, info() {}, warn() {} },
        util: { cloneMessage: (message) => ({ ...message }) },
        nodes: {
            createNode(node) {
                const emitter = new EventEmitter();
                node.id = 'sonos-resume-node';
                node.on = emitter.on.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.send = (messages) => sent.push(messages);
                node.status = () => {};
            },
            getNode: () => server,
            registerType(name, constructor) { if (name === 'ttsultimate') NodeConstructor = constructor; }
        }
    };
    require(runtimePath)(RED);
    const node = new NodeConstructor({ config: 'tts-config', playertype: 'sonos', sonosipaddress: '127.0.0.1', sonosvolume: '40', sonoshailing: '0', voice: 'it', rules: [] });
    t.after(async () => {
        await new Promise((resolve) => node.emit('close', resolve));
        sonosModule.Sonos = OriginalSonos;
        delete require.cache[runtimePath];
    });

    // The node accepts messages once its first Sonos health check (after 5s) has passed.
    let deadline = Date.now() + 8000;
    while (!sent.some((m) => m && m[1] && m[1].payload === false) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    node.emit('input', { payload: announcement });
    deadline = Date.now() + 15000;
    while (!sent.some((m) => m && m[0] && m[0].payload === true) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(fake.state.actions.includes('Play'), 'the announcement was played');
    assert.deepEqual(
        { uri: fake.state.uri, track: fake.state.track, relTime: fake.state.relTime, playMode: fake.state.playMode, transport: fake.state.transport, volume: fake.state.volume, queueLength: fake.state.queueLength },
        { uri: QUEUE_URI, track: 4, relTime: '0:01:30', playMode: 'REPEAT_ALL', transport: 'PLAYING', volume: 22, queueLength: 10 }
    );
    assert.equal(fake.state.actions.includes('AddURIToQueue'), false);
});
