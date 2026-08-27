'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');

const {
    clampVolume,
    createAirPlayPlayer,
    isHttpUrl,
    validateAudioSource
} = require('../ttsultimate/lib/airplay-player');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, reject, resolve };
}

function createHarness(options) {
    const opts = options || {};
    const calls = [];
    const deviceCalls = [];
    const warnings = [];
    const instances = [];
    const raopClients = [];
    const sources = [];
    const timingServers = [];
    let loadCalls = 0;
    let resolveCalls = 0;
    let sourceSequence = 0;
    let volumeSetCalls = 0;

    function createUniqueSource(kind) {
        sourceSequence += 1;
        const source = {
            id: kind + '-source-' + sourceSequence,
            async stop() {
                calls.push(['source.stop', source.id]);
                if (opts.sourceStopError) throw opts.sourceStopError;
            }
        };
        sources.push(source);
        return source;
    }

    const localSource = {
        id: 'local-source',
        async stop() {
            calls.push(['source.stop', 'local']);
            if (opts.sourceStopError) throw opts.sourceStopError;
        }
    };
    const remoteSource = {
        id: 'remote-source',
        async stop() {
            calls.push(['source.stop', 'remote']);
            if (opts.sourceStopError) throw opts.sourceStopError;
        }
    };

    class HomePod {
        constructor(deviceOptions) {
            calls.push(['HomePod', deviceOptions]);
            deviceCalls.push(['HomePod', deviceOptions.address]);
            this.options = deviceOptions;
            const volumeState = opts.volumeStateForDevice ?
                opts.volumeStateForDevice(deviceOptions.address) :
                opts.volumeState;
            if (volumeState) this.airplay = { state: volumeState };
            this.volume = {
                set: async (value) => {
                    volumeSetCalls += 1;
                    calls.push(['volume.set', value]);
                    deviceCalls.push(['volume.set', deviceOptions.address, value]);
                    if (opts.volumeSet) return opts.volumeSet(value, this, volumeSetCalls);
                    if (opts.volumeError) throw opts.volumeError;
                },
                setForDevice: async (uid, value) => {
                    calls.push(['volume.setForDevice', uid, value]);
                    deviceCalls.push(['volume.setForDevice', deviceOptions.address, uid, value]);
                    if (opts.volumeSetForDevice) return opts.volumeSetForDevice(uid, value, this);
                    if (opts.volumeForDeviceError) throw opts.volumeForDeviceError;
                },
                unmute: async () => {
                    calls.push(['volume.unmute']);
                    deviceCalls.push(['volume.unmute', deviceOptions.address]);
                    if (opts.unmute) return opts.unmute(this);
                    if (opts.unmuteError) throw opts.unmuteError;
                },
                unmuteDevice: async (uid) => {
                    calls.push(['volume.unmuteDevice', uid]);
                    deviceCalls.push(['volume.unmuteDevice', deviceOptions.address, uid]);
                    if (opts.unmuteDevice) return opts.unmuteDevice(uid, this);
                    if (opts.unmuteDeviceError) throw opts.unmuteDeviceError;
                }
            };
            if (opts.receiverInfoForDevice) {
                this.receiverInfo = opts.receiverInfoForDevice(deviceOptions.address);
            } else if (opts.receiverInfo) {
                this.receiverInfo = opts.receiverInfo;
            }
            this.media = {
                streamAudio: async (source) => {
                    calls.push(['media.streamAudio', source.id]);
                    deviceCalls.push(['media.streamAudio', deviceOptions.address, source.id]);
                    if (opts.streamAudio) return opts.streamAudio(source, this);
                    if (opts.streamError) throw opts.streamError;
                },
                stopStreamAudio: () => {
                    calls.push(['media.stopStreamAudio']);
                    deviceCalls.push(['media.stopStreamAudio', deviceOptions.address]);
                    if (opts.stopStreamAudio) return opts.stopStreamAudio(this);
                    if (opts.stopStreamError) throw opts.stopStreamError;
                }
            };
            instances.push(this);
        }

        async connect() {
            calls.push(['connect']);
            deviceCalls.push(['connect', this.options.address]);
            if (opts.connect) return opts.connect(this);
            if (opts.connectError) throw opts.connectError;
        }

        disconnect() {
            calls.push(['disconnect']);
            deviceCalls.push(['disconnect', this.options.address]);
            if (opts.disconnectError) throw opts.disconnectError;
        }
    }

    const modules = {
        sdk: {
            HomePod,
            Proto: {
                VolumeCapabilities_Enum: {
                    Absolute: 2,
                    Both: 3
                }
            }
        },
        audio: {
            File: {
                fromPath: async (source) => {
                    calls.push(['File.fromPath', source]);
                    if (opts.fileError) throw opts.fileError;
                    if (opts.fileFromPath) return opts.fileFromPath(source, createUniqueSource);
                    if (opts.uniqueSources) return createUniqueSource('local');
                    return localSource;
                }
            },
            Mp3: {
                fromBuffer: async (buffer) => {
                    calls.push(['Mp3.fromBuffer', buffer.length, buffer.byteOffset]);
                    if (opts.mp3Error) throw opts.mp3Error;
                    return remoteSource;
                }
            },
            Url: {
                fromUrl: async (source) => {
                    calls.push(['Url.fromUrl', source]);
                    if (opts.urlError) throw opts.urlError;
                    return remoteSource;
                }
            }
        }
    };

    if (opts.useRaop) {
        let raopClientSequence = 0;
        let timingServerSequence = 0;

        class TimingServer {
            constructor() {
                timingServerSequence += 1;
                this.id = 'timing-server-' + timingServerSequence;
                calls.push(['TimingServer', this.id]);
                timingServers.push(this);
            }

            async listen() {
                calls.push(['TimingServer.listen', this.id]);
                if (opts.timingServerListen) return opts.timingServerListen(this);
                if (opts.timingServerListenError) throw opts.timingServerListenError;
            }

            close() {
                calls.push(['TimingServer.close', this.id]);
                if (opts.timingServerClose) return opts.timingServerClose(this);
                if (opts.timingServerCloseError) throw opts.timingServerCloseError;
            }
        }

        modules.common = {
            Discovery: {
                raop() {
                    calls.push(['Discovery.raop']);
                    return {
                        async find(useCache) {
                            calls.push(['Discovery.raop.find', useCache]);
                            if (opts.raopDiscovery) return opts.raopDiscovery(useCache);
                            if (opts.raopDiscoveryError) throw opts.raopDiscoveryError;
                            return opts.raopResults || [];
                        }
                    };
                }
            },
            TimingServer
        };
        modules.raop = {
            RaopClient: {
                async create(discoveryResult, timingServer) {
                    calls.push(['RaopClient.create', discoveryResult, timingServer]);
                    if (opts.raopCreate) return opts.raopCreate(discoveryResult, timingServer);
                    if (opts.raopCreateError) throw opts.raopCreateError;

                    raopClientSequence += 1;
                    const serviceIdentity = String(discoveryResult.id || discoveryResult.fqdn || '');
                    const hardwarePrefix = serviceIdentity.split('@')[0].replace(/[^a-fA-F0-9]/g, '');
                    const client = {
                        id: 'raop-client-' + raopClientSequence,
                        info: opts.raopInfoForResult ?
                            opts.raopInfoForResult(discoveryResult) :
                            (/^[a-fA-F0-9]{12}$/.test(hardwarePrefix) ?
                                { macAddress: hardwarePrefix } : {}),
                        async stream(source, streamOptions) {
                            calls.push(['RaopClient.stream', client.id, source.id, streamOptions]);
                            try {
                                if (opts.raopStream) return await opts.raopStream(source, streamOptions, client);
                            } finally {
                                calls.push(['RaopClient.stream.settled', client.id]);
                            }
                        },
                        stop() {
                            calls.push(['RaopClient.stop', client.id]);
                            if (opts.raopStop) return opts.raopStop(client);
                            if (opts.raopStopError) throw opts.raopStopError;
                        },
                        async close() {
                            calls.push(['RaopClient.close', client.id]);
                            if (opts.raopClose) return opts.raopClose(client);
                            if (opts.raopCloseError) throw opts.raopCloseError;
                        }
                    };
                    raopClients.push(client);
                    return client;
                }
            }
        };
    }

    const player = createAirPlayPlayer(Object.assign({
        allowedLocalRoot: '/srv/tts-storage',
        connectTimeoutMs: 0,
        sourceTimeoutMs: 0,
        playbackTimeoutMs: 0,
        fetch: async (url, requestOptions) => {
            calls.push(['fetch', url, requestOptions.signal]);
            if (opts.fetch) return opts.fetch(url, requestOptions);
            const bytes = Uint8Array.from([0x49, 0x44, 0x33]);
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => String(bytes.byteLength) },
                arrayBuffer: async () => bytes.buffer
            };
        },
        loadModules: async () => {
            loadCalls += 1;
            return modules;
        },
        // Kept as a tripwire while the implementation evolves: playback must
        // use HomePod({address}) directly and must not perform a second scan.
        resolveTarget: async () => {
            resolveCalls += 1;
            return null;
        },
        logger: {
            warn(message) {
                warnings.push(message);
            }
        }
    }, opts.playerOptions));

    return {
        calls,
        deviceCalls,
        instances,
        localSource,
        modules,
        player,
        raopClients,
        remoteSource,
        sources,
        timingServers,
        warnings,
        get loadCalls() {
            return loadCalls;
        },
        get resolveCalls() {
            return resolveCalls;
        }
    };
}

test('play streams an allowed local MP3 with direct-address HomePod and cleans up', async () => {
    const harness = createHarness();

    await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/Announcement.MP3',
        35
    );

    assert.equal(harness.resolveCalls, 0);
    assert.deepEqual(
        harness.deviceCalls.find((call) => call[0] === 'HomePod'),
        ['HomePod', '192.168.1.50']
    );
    assert.equal(
        harness.calls.some((call) => call[0] === 'File.fromPath' && call[1].endsWith('Announcement.MP3')),
        true
    );
    assert.equal(harness.calls.some((call) => call[0] === 'Url.fromUrl'), false);
    assert.equal(harness.calls.some((call) => call[0] === 'volume.set' && call[1] === 0.35), true);
    assert.equal(harness.calls.some((call) => call[0] === 'media.streamAudio' && call[1] === 'local-source'), true);
    assert.equal(harness.calls.filter((call) => call[0] === 'media.stopStreamAudio').length, 1);
    assert.equal(harness.calls.filter((call) => call[0] === 'source.stop').length, 1);
    assert.equal(harness.calls.filter((call) => call[0] === 'disconnect').length, 1);
    assert.equal(harness.player.activeCount, 0);
});

test('RAOP discovers the requested address, streams with percent volume, and owns cleanup', async () => {
    const otherResult = {
        // apple-common can return unrelated records from the same mDNS packet.
        // A same-address HTTP service must never win over the RAOP descriptor.
        address: '192.168.1.50',
        fqdn: 'selected-homepod.local',
        name: 'Selected HomePod Web UI',
        service: { type: '_http._tcp.local', port: 8080 }
    };
    const selectedResult = {
        address: '192.168.1.50',
        fqdn: 'selected-homepod.local',
        name: 'Selected HomePod',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const harness = createHarness({
        useRaop: true,
        raopResults: [otherResult, selectedResult]
    });

    const outcome = await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/Announcement.MP3',
        35
    );

    assert.deepEqual(outcome, { status: 'completed', target: '192.168.1.50' });
    assert.equal(harness.timingServers.length, 1);
    assert.deepEqual(
        harness.calls.find((call) => call[0] === 'Discovery.raop.find'),
        ['Discovery.raop.find', false]
    );

    const createCall = harness.calls.find((call) => call[0] === 'RaopClient.create');
    assert.strictEqual(createCall[1], selectedResult);
    assert.strictEqual(createCall[2], harness.timingServers[0]);
    assert.deepEqual(
        harness.calls.find((call) => call[0] === 'RaopClient.stream').slice(2),
        ['local-source', { volume: 35 }]
    );

    assert.equal(harness.calls.some((call) => call[0] === 'media.streamAudio'), false);
    assert.equal(harness.calls.some((call) => call[0] === 'volume.set'), false);
    assert.equal(harness.calls.filter((call) => call[0] === 'RaopClient.stop').length, 1);
    assert.equal(harness.calls.filter((call) => call[0] === 'RaopClient.close').length, 1);
    assert.equal(harness.calls.filter((call) => call[0] === 'TimingServer.close').length, 1);
    assert.equal(harness.calls.some((call) => call[0] === 'media.stopStreamAudio'), false);
    assert.equal(harness.calls.some((call) => call[0] === 'source.stop'), false);

    const listenIndex = harness.calls.findIndex((call) => call[0] === 'TimingServer.listen');
    const createIndex = harness.calls.findIndex((call) => call[0] === 'RaopClient.create');
    const streamIndex = harness.calls.findIndex((call) => call[0] === 'RaopClient.stream');
    const closeIndex = harness.calls.findIndex((call) => call[0] === 'RaopClient.close');
    const timingCloseIndex = harness.calls.findIndex((call) => call[0] === 'TimingServer.close');
    assert.equal(listenIndex < createIndex, true);
    assert.equal(createIndex < streamIndex, true);
    assert.equal(streamIndex < closeIndex, true);
    assert.equal(closeIndex < timingCloseIndex, true);
    assert.equal(harness.player.activeCount, 0);
});

test('RAOP resolves an AirPlay hardware selector to the matching receiver', async () => {
    const unrelated = {
        address: '192.168.1.49',
        id: '112233445566@other-homepod.local',
        fqdn: '112233445566@other-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const selected = {
        address: '192.168.1.50',
        id: 'AABBCCDDEEFF@selected-homepod.local',
        fqdn: 'AABBCCDDEEFF@selected-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const harness = createHarness({
        useRaop: true,
        raopResults: [unrelated, selected]
    });

    await harness.player.play(
        'raop-device:aabbccddeeff',
        '/srv/tts-storage/cache/Announcement.MP3',
        35
    );

    assert.strictEqual(
        harness.calls.find((call) => call[0] === 'RaopClient.create')[1],
        selected
    );
});

test('RAOP discovery is cached per normalized target address', async () => {
    const selectedResult = {
        address: '192.168.1.50',
        id: 'AABBCCDDEEFF@selected-homepod.local',
        fqdn: 'AABBCCDDEEFF@selected-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const harness = createHarness({
        useRaop: true,
        raopResults: [selectedResult]
    });

    await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/first.mp3',
        20
    );
    await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/second.mp3',
        80
    );

    assert.equal(harness.calls.filter((call) => call[0] === 'Discovery.raop').length, 1);
    assert.equal(harness.calls.filter((call) => call[0] === 'Discovery.raop.find').length, 1);
    assert.equal(harness.calls.filter((call) => call[0] === 'RaopClient.create').length, 2);
    assert.deepEqual(
        harness.calls.filter((call) => call[0] === 'RaopClient.stream')
            .map((call) => call[3].volume),
        [20, 80]
    );
    assert.equal(harness.calls.filter((call) => call[0] === 'TimingServer.listen').length, 2);
    assert.equal(harness.calls.filter((call) => call[0] === 'TimingServer.close').length, 2);
    assert.equal(harness.player.activeCount, 0);
});

test('a stale RAOP cache is rediscovered and retried in the same playback after DHCP changes', async () => {
    const beforeRestart = {
        address: '192.168.1.50',
        id: 'AABBCCDDEEFF@selected-homepod.local',
        fqdn: 'AABBCCDDEEFF@selected-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const afterRestart = Object.assign({}, beforeRestart, { address: '192.168.1.87' });
    const createAddresses = [];
    const streamAddresses = [];
    let currentResult = beforeRestart;
    let addressChanged = false;

    const harness = createHarness({
        useRaop: true,
        raopDiscovery: async () => [currentResult],
        raopCreate: async (discoveryResult) => {
            createAddresses.push(discoveryResult.address);
            if (addressChanged && discoveryResult.address === beforeRestart.address) {
                throw new Error('connect ECONNREFUSED ' + beforeRestart.address);
            }
            return {
                async stream() {
                    streamAddresses.push(discoveryResult.address);
                },
                stop() { },
                async close() { }
            };
        }
    });

    await harness.player.play(
        'selected-homepod.local',
        '/srv/tts-storage/cache/before-restart.mp3',
        35
    );

    addressChanged = true;
    currentResult = afterRestart;
    const outcome = await harness.player.play(
        'selected-homepod.local',
        '/srv/tts-storage/cache/after-restart.mp3',
        35
    );

    assert.deepEqual(outcome, { status: 'completed', target: 'selected-homepod.local' });
    assert.deepEqual(createAddresses, [
        '192.168.1.50',
        '192.168.1.50',
        '192.168.1.87'
    ]);
    assert.deepEqual(streamAddresses, ['192.168.1.50', '192.168.1.87']);
    assert.equal(
        harness.calls.filter((call) => call[0] === 'Discovery.raop.find').length,
        2,
        'the healthy cache is reused and only the failed playback forces one fresh scan'
    );
    assert.equal(harness.player.activeCount, 0);
});

test('a cached address reassigned to another HomePod is rejected by receiver identity', async () => {
    const configuredIdentity = 'AABBCCDDEEFF@selected-homepod.local';
    const beforeRestart = {
        address: '192.168.1.50',
        id: configuredIdentity,
        fqdn: configuredIdentity,
        service: { type: '_raop._tcp', port: 7000 }
    };
    const unrelatedAtOldAddress = {
        address: '192.168.1.50',
        id: '112233445566@other-homepod.local',
        fqdn: '112233445566@other-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const movedHomePod = Object.assign({}, beforeRestart, { address: '192.168.1.87' });
    let moved = false;
    let wrongClientCloseCalls = 0;
    let wrongClientStreamCalls = 0;
    const createAddresses = [];
    const streamedAddresses = [];
    const harness = createHarness({
        useRaop: true,
        raopDiscovery: async () => moved ? [unrelatedAtOldAddress, movedHomePod] : [beforeRestart],
        raopCreate: async (discoveryResult) => {
            createAddresses.push(discoveryResult.address);
            if (moved && discoveryResult.address === beforeRestart.address) {
                return {
                    info: { macAddress: '11:22:33:44:55:66' },
                    async stream() { wrongClientStreamCalls += 1; },
                    stop() { },
                    async close() { wrongClientCloseCalls += 1; }
                };
            }
            return {
                info: { macAddress: 'AA:BB:CC:DD:EE:FF' },
                async stream() { streamedAddresses.push(discoveryResult.address); },
                stop() { },
                async close() { }
            };
        }
    });

    await harness.player.play(
        configuredIdentity,
        '/srv/tts-storage/cache/before-restart.mp3',
        50
    );
    moved = true;
    await harness.player.play(
        configuredIdentity,
        '/srv/tts-storage/cache/after-restart.mp3',
        50
    );

    assert.deepEqual(createAddresses, ['192.168.1.50', '192.168.1.50', '192.168.1.87']);
    assert.deepEqual(streamedAddresses, ['192.168.1.50', '192.168.1.87']);
    assert.equal(wrongClientStreamCalls, 0, 'the reassigned lease must never receive audio');
    assert.equal(wrongClientCloseCalls, 1, 'the identity-mismatched client must be closed');
    assert.equal(
        harness.calls.filter((call) => call[0] === 'Discovery.raop.find').length,
        2
    );
});

test('a black-holed cached RAOP endpoint times out without cancelling rediscovery', async () => {
    const beforeRestart = {
        address: '192.168.1.50',
        id: 'AABBCCDDEEFF@selected-homepod.local',
        fqdn: 'AABBCCDDEEFF@selected-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const afterRestart = Object.assign({}, beforeRestart, { address: '192.168.1.87' });
    const staleCreate = deferred();
    let currentResult = beforeRestart;
    let moved = false;
    let lateCloseCalls = 0;
    const streamed = [];
    const harness = createHarness({
        useRaop: true,
        raopDiscovery: async () => [currentResult],
        raopCreate: async (discoveryResult) => {
            if (moved && discoveryResult.address === beforeRestart.address) {
                return staleCreate.promise;
            }
            return {
                async stream() { streamed.push(discoveryResult.address); },
                stop() { },
                async close() { }
            };
        },
        playerOptions: {
            connectTimeoutMs: 100,
            staleTargetTimeoutMs: 5
        }
    });

    await harness.player.play(
        'selected-homepod.local',
        '/srv/tts-storage/cache/before-restart.mp3',
        50
    );
    moved = true;
    currentResult = afterRestart;
    await harness.player.play(
        'selected-homepod.local',
        '/srv/tts-storage/cache/after-restart.mp3',
        50
    );

    assert.deepEqual(streamed, ['192.168.1.50', '192.168.1.87']);
    assert.equal(harness.player.activeCount, 0);

    staleCreate.resolve({
        stop() { },
        async close() { lateCloseCalls += 1; }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lateCloseCalls, 1, 'a client returned after the stale timeout must be closed');
});

test('a cached legacy IP target uses its prior RAOP identity after the lease changes', async () => {
    const beforeRestart = {
        address: '192.168.1.50',
        id: 'AABBCCDDEEFF@selected-homepod.local',
        fqdn: 'AABBCCDDEEFF@selected-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const unrelatedAtOldAddress = {
        address: '192.168.1.50',
        // Same human suffix as the old descriptor: only the hardware prefix can
        // safely distinguish this new lease owner from the moved HomePod.
        id: '112233445566@selected-homepod.local',
        fqdn: '112233445566@selected-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const movedHomePod = Object.assign({}, beforeRestart, {
        address: '192.168.1.87',
        id: 'AABBCCDDEEFF@renamed-homepod.local',
        fqdn: 'AABBCCDDEEFF@renamed-homepod.local'
    });
    let moved = false;
    const streamed = [];
    const harness = createHarness({
        useRaop: true,
        raopDiscovery: async () => moved ? [unrelatedAtOldAddress, movedHomePod] : [beforeRestart],
        raopCreate: async (discoveryResult) => {
            if (moved && discoveryResult.address === beforeRestart.address) {
                throw new Error('stale lease');
            }
            return {
                async stream() { streamed.push(discoveryResult.id); },
                stop() { },
                async close() { }
            };
        }
    });

    await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/before-restart.mp3',
        50
    );
    moved = true;
    await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/after-restart.mp3',
        50
    );

    assert.deepEqual(streamed, [beforeRestart.id, movedHomePod.id]);
    assert.equal(streamed.includes(unrelatedAtOldAddress.id), false);
});

test('an expired cache resolves the persisted RAOP hardware identity instead of a reassigned IP', async () => {
    const configuredIdentity = 'AABBCCDDEEFF@selected-homepod.local';
    const beforeRestart = {
        address: '192.168.1.50',
        id: configuredIdentity,
        fqdn: configuredIdentity,
        service: { type: '_raop._tcp', port: 7000 }
    };
    const unrelatedAtOldAddress = {
        address: '192.168.1.50',
        id: '112233445566@selected-homepod.local',
        fqdn: '112233445566@selected-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const movedHomePod = {
        address: '192.168.1.87',
        id: 'AABBCCDDEEFF@renamed-homepod.local',
        fqdn: 'AABBCCDDEEFF@renamed-homepod.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    let moved = false;
    const createdFor = [];
    const harness = createHarness({
        useRaop: true,
        raopDiscovery: async () => moved ? [unrelatedAtOldAddress, movedHomePod] : [beforeRestart],
        raopCreate: async (discoveryResult) => {
            createdFor.push(discoveryResult.id);
            return {
                async stream() { },
                stop() { },
                async close() { }
            };
        },
        playerOptions: { raopCacheTtlMs: 1 }
    });

    await harness.player.play(
        configuredIdentity,
        '/srv/tts-storage/cache/before-restart.mp3',
        50
    );
    moved = true;
    await new Promise((resolve) => setTimeout(resolve, 3));
    await harness.player.play(
        configuredIdentity,
        '/srv/tts-storage/cache/after-restart.mp3',
        50
    );

    assert.deepEqual(createdFor, [beforeRestart.id, movedHomePod.id]);
    assert.equal(createdFor.includes(unrelatedAtOldAddress.id), false);
});

test('RAOP groups resolve stable selectors before creating HomePod control sessions', async () => {
    const masterResult = {
        address: '192.168.1.87',
        id: 'AABBCCDDEEFF@living-room.local',
        fqdn: 'AABBCCDDEEFF@living-room.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const additionalResult = {
        address: '192.168.1.88',
        id: '112233445566@kitchen.local',
        fqdn: '112233445566@kitchen.local',
        service: { type: '_raop._tcp.local', port: 7000 }
    };
    const harness = createHarness({
        useRaop: true,
        uniqueSources: true,
        raopResults: [masterResult, additionalResult]
    });

    const result = await harness.player.playGroup(
        { host: 'living-room.local', volume: 45 },
        [{ host: 'kitchen.local', volume: 30 }],
        '/srv/tts-storage/cache/group.mp3'
    );

    assert.deepEqual(
        harness.deviceCalls.filter((call) => call[0] === 'HomePod'),
        [
            ['HomePod', '192.168.1.87'],
            ['HomePod', '192.168.1.88']
        ]
    );
    assert.deepEqual(
        harness.calls.filter((call) => call[0] === 'RaopClient.create')
            .map((call) => call[1].address)
            .sort(),
        ['192.168.1.87', '192.168.1.88']
    );
    assert.deepEqual(result.additionalResults.map((item) => item.status), ['fulfilled']);
    assert.equal(harness.player.activeCount, 0);
});

test('a group refreshes a black-holed cached address before retrying its control session', async () => {
    const masterBeforeRestart = {
        address: '192.168.1.50',
        id: 'AABBCCDDEEFF@living-room.local',
        fqdn: 'AABBCCDDEEFF@living-room.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const masterAfterRestart = Object.assign({}, masterBeforeRestart, { address: '192.168.1.87' });
    const additional = {
        address: '192.168.1.60',
        id: '112233445566@kitchen.local',
        fqdn: '112233445566@kitchen.local',
        service: { type: '_raop._tcp', port: 7000 }
    };
    const staleConnect = deferred();
    let moved = false;
    const harness = createHarness({
        useRaop: true,
        uniqueSources: true,
        raopDiscovery: async () => [moved ? masterAfterRestart : masterBeforeRestart, additional],
        connect: async (device) => {
            if (moved && device.options.address === masterBeforeRestart.address) {
                return staleConnect.promise;
            }
        },
        playerOptions: {
            connectTimeoutMs: 100,
            staleTargetTimeoutMs: 5
        }
    });

    const master = { host: 'living-room.local', volume: 45 };
    const companions = [{ host: 'kitchen.local', volume: 30 }];
    await harness.player.playGroup(master, companions, '/srv/tts-storage/cache/before-restart.mp3');
    moved = true;
    await harness.player.playGroup(master, companions, '/srv/tts-storage/cache/after-restart.mp3');

    const controlAddresses = harness.deviceCalls
        .filter((call) => call[0] === 'HomePod')
        .map((call) => call[1]);
    assert.equal(controlAddresses.filter((address) => address === '192.168.1.50').length, 2);
    assert.equal(controlAddresses.filter((address) => address === '192.168.1.87').length, 1);
    assert.equal(controlAddresses.filter((address) => address === '192.168.1.60').length, 2);
    assert.equal(
        harness.calls.filter((call) => call[0] === 'Discovery.raop.find').length,
        3,
        'only the stale master should force an additional fresh lookup'
    );
    assert.deepEqual(
        harness.calls.filter((call) => call[0] === 'RaopClient.create')
            .map((call) => call[1].address)
            .sort(),
        ['192.168.1.50', '192.168.1.50', '192.168.1.60', '192.168.1.60', '192.168.1.87'],
        'the second master stream must use the refreshed descriptor too'
    );
    assert.equal(harness.player.activeCount, 0);

    const disconnectsBeforeLateSuccess = harness.deviceCalls.filter((call) =>
        call[0] === 'disconnect' && call[1] === masterBeforeRestart.address
    ).length;
    staleConnect.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        harness.deviceCalls.filter((call) =>
            call[0] === 'disconnect' && call[1] === masterBeforeRestart.address
        ).length,
        disconnectsBeforeLateSuccess + 1,
        'a stale MRP connection that succeeds after its timeout must be disconnected again'
    );
});

test('stop settles a RAOP stream before closing its client and timing server', async () => {
    const streamStarted = deferred();
    const streamFinished = deferred();
    let stopCalls = 0;
    const harness = createHarness({
        useRaop: true,
        raopResults: [{
            address: '192.168.1.50',
            fqdn: 'selected-homepod.local',
            service: { type: '_raop._tcp', port: 7000 }
        }],
        raopStream: async () => {
            streamStarted.resolve();
            return streamFinished.promise;
        },
        raopStop: () => {
            stopCalls += 1;
            streamFinished.resolve();
        },
        playerOptions: {
            cancelRetryIntervalMs: 1,
            cancelRetryTimeoutMs: 100
        }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        55
    );
    await streamStarted.promise;
    assert.equal(harness.player.activeCount, 1);

    await harness.player.stop();
    const outcome = await playback;

    assert.deepEqual(outcome, {
        reason: 'user',
        status: 'stopped',
        target: '192.168.1.50'
    });
    assert.equal(stopCalls >= 1, true);
    assert.equal(harness.calls.filter((call) => call[0] === 'RaopClient.close').length, 1);
    assert.equal(harness.calls.filter((call) => call[0] === 'TimingServer.close').length, 1);
    assert.equal(harness.calls.some((call) => call[0] === 'media.streamAudio'), false);
    assert.equal(harness.calls.some((call) => call[0] === 'media.stopStreamAudio'), false);
    assert.equal(harness.calls.some((call) => call[0] === 'volume.set'), false);

    const streamSettledIndex = harness.calls.findIndex((call) => call[0] === 'RaopClient.stream.settled');
    const closeIndex = harness.calls.findIndex((call) => call[0] === 'RaopClient.close');
    const timingCloseIndex = harness.calls.findIndex((call) => call[0] === 'TimingServer.close');
    assert.equal(streamSettledIndex < closeIndex, true);
    assert.equal(closeIndex < timingCloseIndex, true);
    assert.equal(harness.player.activeCount, 0);
});

test('a RAOP client that resolves after connection timeout is closed and cannot leak', async () => {
    const createStarted = deferred();
    const createFinished = deferred();
    let lateCloseCalls = 0;
    const lateClient = {
        async stream() { },
        stop() { },
        async close() {
            lateCloseCalls += 1;
        }
    };
    const harness = createHarness({
        useRaop: true,
        raopResults: [{
            address: '192.168.1.50',
            fqdn: 'selected-homepod.local',
            service: { type: '_raop._tcp', port: 7000 }
        }],
        raopCreate: async () => {
            createStarted.resolve();
            return createFinished.promise;
        },
        playerOptions: {
            connectTimeoutMs: 5
        }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/Announcement.mp3',
        35
    );
    await createStarted.promise;
    await assert.rejects(playback, /RAOP connection timed out/i);
    assert.equal(harness.player.activeCount, 0);

    createFinished.resolve(lateClient);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lateCloseCalls, 1);
    assert.equal(harness.timingServers.length, 1);
    assert.equal(
        harness.calls.filter((call) => call[0] === 'TimingServer.close').length >= 1,
        true
    );
});

test('play downloads an HTTP MP3 with a bounded fetch and no local root', async () => {
    const harness = createHarness({
        playerOptions: { allowedLocalRoot: undefined }
    });

    await harness.player.play(
        'homepod-kitchen.local',
        'HTTPS://audio.example.test/tts.mp3',
        'not-a-number'
    );

    assert.deepEqual(
        harness.deviceCalls.find((call) => call[0] === 'HomePod'),
        ['HomePod', 'homepod-kitchen.local']
    );
    assert.equal(harness.calls.some((call) => call[0] === 'fetch'), true);
    assert.equal(harness.calls.some((call) => call[0] === 'Mp3.fromBuffer'), true);
    assert.equal(harness.calls.some((call) => call[0] === 'Url.fromUrl'), false);
    assert.equal(harness.calls.some((call) => call[0] === 'File.fromPath'), false);
    assert.equal(harness.calls.some((call) => call[0] === 'volume.set' && call[1] === 0.5), true);
    assert.equal(harness.calls.some((call) => call[0] === 'media.streamAudio' && call[1] === 'remote-source'), true);
});

test('local files require an allowed root, stay inside it, and must be MP3', async (t) => {
    const cases = [
        {
            name: 'missing allowed root',
            root: undefined,
            source: '/srv/tts-storage/cache/voice.mp3'
        },
        {
            name: 'parent traversal',
            root: '/srv/tts-storage',
            source: '/srv/tts-storage/cache/../../private/OwnFile_secret.mp3'
        },
        {
            name: 'sibling prefix',
            root: '/srv/tts-storage',
            source: '/srv/tts-storage-evil/voice.mp3'
        },
        {
            name: 'wrong extension',
            root: '/srv/tts-storage',
            source: '/srv/tts-storage/cache/voice.wav'
        }
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const harness = createHarness({
                playerOptions: { allowedLocalRoot: item.root }
            });

            await assert.rejects(
                harness.player.play('192.168.1.50', item.source, 50),
                /AirPlay|local|root|MP3|allowed/i
            );
            assert.equal(
                harness.calls.filter((call) => call[0] === 'File.fromPath').length,
                0,
                'unsafe paths must be rejected before File.fromPath'
            );
            assert.equal(harness.player.activeCount, 0);
        });
    }
});

test('local source validation rejects a symlink escaping the storage root', (t) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-airplay-path-'));
    const allowedRoot = path.join(fixtureRoot, 'allowed');
    const outsideFile = path.join(fixtureRoot, 'outside.mp3');
    const linkedFile = path.join(allowedRoot, 'linked.mp3');
    fs.mkdirSync(allowedRoot);
    fs.writeFileSync(outsideFile, 'not audio');
    fs.symlinkSync(outsideFile, linkedFile);
    t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

    assert.throws(
        () => validateAudioSource(linkedFile, allowedRoot),
        /configured storage folder/i
    );
});

test('invalid target/source fail before loading the ESM dependencies', async () => {
    const harness = createHarness();

    await assert.rejects(harness.player.play('', 'https://example.test/a.mp3', 50), /no HomePod/i);
    await assert.rejects(harness.player.play('192.168.1.50', '   ', 50), /no audio source/i);
    assert.equal(harness.loadCalls, 0);
    assert.equal(harness.player.activeCount, 0);
});

test('volume is clamped to 0..100 and invalid values fall back to 50', () => {
    assert.equal(clampVolume(-1), 0);
    assert.equal(clampVolume('-20'), 0);
    assert.equal(clampVolume(0), 0);
    assert.equal(clampVolume('42'), 42);
    assert.equal(clampVolume(100), 100);
    assert.equal(clampVolume(101), 100);
    assert.equal(clampVolume(Infinity), 100);
    assert.equal(clampVolume('invalid'), 50);
});

test('HTTP source detection is case-insensitive and excludes other schemes', () => {
    assert.equal(isHttpUrl('http://example.test/a.mp3'), true);
    assert.equal(isHttpUrl('HTTPS://example.test/a.mp3'), true);
    assert.equal(isHttpUrl('/srv/tts/a.mp3'), false);
    assert.equal(isHttpUrl('file:///srv/tts/a.mp3'), false);
    assert.equal(isHttpUrl('ftp://example.test/a.mp3'), false);
});

test('a volume error is best-effort and playback continues with a warning', async () => {
    const harness = createHarness({ volumeError: new Error('volume unavailable') });

    await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        75
    );

    assert.equal(harness.calls.some((call) => call[0] === 'media.streamAudio'), true);
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0], /volume unavailable/);
});

test('fallback retries volume and unmute after stream start when the first command is rejected', async () => {
    const streamFinished = deferred();
    let attempts = 0;
    const harness = createHarness({
        streamAudio: async () => streamFinished.promise,
        volumeSet: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('No output device active.');
        },
        playerOptions: {
            volumeRetryIntervalMs: 1,
            volumeTimeoutMs: 200
        }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        75
    );

    const deadline = Date.now() + 200;
    while (attempts < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(attempts, 2);
    assert.ok(
        harness.calls.findIndex((call) => call[0] === 'media.streamAudio') <
        harness.calls.findIndex((call) => call[0] === 'volume.set'),
        'the audio stream must start before the first volume command'
    );
    assert.equal(harness.calls.filter((call) => call[0] === 'volume.unmute').length, 1);
    assert.equal(harness.warnings.length, 0);

    streamFinished.resolve();
    await playback;
});

test('deviceInfo readiness applies volume and unmute before the first audio frame', async () => {
    const volumeState = new EventEmitter();
    volumeState.outputDeviceUID = null;
    volumeState.volumeAvailable = false;
    volumeState.volumeCapabilities = 0;
    const streamFinished = deferred();
    const harness = createHarness({
        connect: async () => {
            setTimeout(() => {
                volumeState.outputDeviceUID = 'homepod-cluster-id';
                volumeState.volumeAvailable = true;
                volumeState.volumeCapabilities = 2;
                volumeState.emit('deviceInfo');
                volumeState.emit('volumeControlAvailability');
            }, 2);
        },
        streamAudio: async () => streamFinished.promise,
        volumeState,
        playerOptions: { volumeReadyTimeoutMs: 100 }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        65
    );

    const deadline = Date.now() + 100;
    while (!harness.calls.some((call) => call[0] === 'media.streamAudio') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const volumeIndex = harness.calls.findIndex((call) => call[0] === 'volume.set');
    const unmuteIndex = harness.calls.findIndex((call) => call[0] === 'volume.unmute');
    const streamIndex = harness.calls.findIndex((call) => call[0] === 'media.streamAudio');
    assert.ok(volumeIndex >= 0 && volumeIndex < streamIndex);
    assert.ok(unmuteIndex >= 0 && unmuteIndex < streamIndex);
    assert.equal(harness.calls.filter((call) => call[0] === 'volume.set').length, 1);

    streamFinished.resolve();
    await playback;
});

test('receiver psi controls volume when MRP outputDeviceUID never becomes active', async () => {
    const volumeState = new EventEmitter();
    volumeState.outputDeviceUID = null;
    volumeState.outputDevices = [];
    volumeState.volumeAvailable = false;
    volumeState.volumeCapabilities = 0;
    const streamFinished = deferred();
    const harness = createHarness({
        receiverInfo: { psi: 'physical-output-psi' },
        streamAudio: async () => streamFinished.promise,
        volumeState,
        playerOptions: { volumeReadyTimeoutMs: 1000 }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        70
    );

    const deadline = Date.now() + 100;
    while (!harness.calls.some((call) => call[0] === 'media.streamAudio') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const streamObserved = harness.calls.some((call) => call[0] === 'media.streamAudio');
    if (!streamObserved) {
        await harness.player.stop();
        await playback;
    }
    assert.equal(streamObserved, true, 'receiver psi must bypass the MRP readiness timeout');
    assert.deepEqual(
        harness.calls.find((call) => call[0] === 'volume.setForDevice'),
        ['volume.setForDevice', 'physical-output-psi', 0.7]
    );
    assert.deepEqual(
        harness.calls.find((call) => call[0] === 'volume.unmuteDevice'),
        ['volume.unmuteDevice', 'physical-output-psi']
    );
    assert.equal(harness.calls.some((call) => call[0] === 'volume.set'), false);

    streamFinished.resolve();
    await playback;
});

test('a hanging volume request does not delay a completed audio stream', async () => {
    const neverVolume = deferred();
    const harness = createHarness({
        volumeSet: async () => neverVolume.promise,
        playerOptions: { volumeTimeoutMs: 1000 }
    });

    const started = Date.now();
    await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        50
    );

    assert.ok(Date.now() - started < 500, 'natural playback completion must win the volume race');
    assert.equal(harness.player.activeCount, 0);
});

test('unmute is attempted even when absolute volume remains unavailable', async () => {
    const streamFinished = deferred();
    let unmuteCalls = 0;
    const harness = createHarness({
        streamAudio: async () => streamFinished.promise,
        volumeError: new Error('absolute volume unavailable'),
        unmute: async () => { unmuteCalls += 1; },
        playerOptions: {
            volumeRetryIntervalMs: 1,
            volumeTimeoutMs: 15
        }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        50
    );

    const deadline = Date.now() + 100;
    while (unmuteCalls === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(unmuteCalls, 1);

    streamFinished.resolve();
    await playback;
});

test('connect, source, and streaming failures are contextual and always clean up', async (t) => {
    const cases = [
        { name: 'connect', option: 'connectError', error: new Error('pairing failed') },
        { name: 'source', option: 'fileError', error: new Error('decoder failed') },
        { name: 'stream', option: 'streamError', error: new Error('RTP failed') }
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const harness = createHarness({ [item.option]: item.error });

            await assert.rejects(
                harness.player.play(
                    '192.168.1.50',
                    '/srv/tts-storage/cache/voice.mp3',
                    50
                ),
                (error) => {
                    assert.match(error.message, /AirPlay 192\.168\.1\.50/);
                    assert.match(error.message, new RegExp(item.error.message));
                    return true;
                }
            );

            const expectedDisconnects = item.name === 'source' ? 0 : 1;
            assert.equal(harness.calls.filter((call) => call[0] === 'disconnect').length, expectedDisconnects);
            assert.equal(harness.player.activeCount, 0);
        });
    }
});

test('close stops active playback and repeated stop/close calls are idempotent', async () => {
    const streamStarted = deferred();
    const streamFinished = deferred();
    const harness = createHarness({
        streamAudio: async () => {
            streamStarted.resolve();
            return streamFinished.promise;
        },
        stopStreamAudio: () => {
            streamFinished.resolve();
        }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        50
    );
    await streamStarted.promise;
    assert.equal(harness.player.activeCount, 1);

    await harness.player.close();
    await playback;
    await harness.player.stop();
    await harness.player.close();

    assert.equal(harness.calls.filter((call) => call[0] === 'media.stopStreamAudio').length >= 1, true);
    assert.equal(harness.calls.filter((call) => call[0] === 'source.stop').length, 1);
    assert.equal(harness.calls.filter((call) => call[0] === 'disconnect').length, 1);
    assert.equal(harness.player.activeCount, 0);
});

test('a connect that resolves after stop is disconnected again and cannot leak', async () => {
    const connectStarted = deferred();
    const connectFinished = deferred();
    const harness = createHarness({
        connect: async () => {
            connectStarted.resolve();
            return connectFinished.promise;
        }
    });

    const playback = harness.player.play(
        'late-connect.local',
        '/srv/tts-storage/cache/voice.mp3',
        50
    );
    await connectStarted.promise;

    await harness.player.stop();
    await playback;
    assert.equal(harness.deviceCalls.filter((call) => call[0] === 'disconnect').length, 1);
    assert.equal(harness.player.activeCount, 0);

    connectFinished.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.deviceCalls.filter((call) => call[0] === 'disconnect').length, 2);
    assert.equal(harness.player.activeCount, 0);
});

test('stop retries while the SDK registers its dedicated stream protocol', async () => {
    const streamStarted = deferred();
    const streamFinished = deferred();
    let registered = false;
    let stopCalls = 0;
    const harness = createHarness({
        streamAudio: async () => {
            streamStarted.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            registered = true;
            return streamFinished.promise;
        },
        stopStreamAudio: () => {
            stopCalls += 1;
            if (registered) streamFinished.resolve();
        },
        playerOptions: {
            cancelRetryIntervalMs: 1,
            cancelRetryTimeoutMs: 100
        }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        50
    );
    await streamStarted.promise;

    await harness.player.stop();
    await playback;

    assert.equal(registered, true);
    assert.equal(stopCalls >= 2, true);
    assert.equal(harness.player.activeCount, 0);
});

test('stop keeps retrying in the background after its foreground deadline', async () => {
    const streamStarted = deferred();
    const streamFinished = deferred();
    let registered = false;
    let stopCalls = 0;
    const harness = createHarness({
        streamAudio: async () => {
            streamStarted.resolve();
            await new Promise((resolve) => setTimeout(resolve, 30));
            registered = true;
            return streamFinished.promise;
        },
        stopStreamAudio: () => {
            stopCalls += 1;
            if (registered) streamFinished.resolve();
        },
        playerOptions: {
            backgroundRetryIntervalMs: 1,
            cancelRetryIntervalMs: 1,
            cancelRetryTimeoutMs: 5
        }
    });

    const playback = harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        50
    );
    await streamStarted.promise;

    await harness.player.stop();
    await playback;
    assert.equal(harness.player.activeCount, 1, 'the unsettled SDK stream remains tracked');

    await streamFinished.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registered, true);
    assert.equal(stopCalls > 2, true);
    assert.equal(harness.player.activeCount, 0);
});

test('remote MP3 downloads enforce the size limit and abort on source timeout', async (t) => {
    await t.test('declared size limit', async () => {
        let aborted = false;
        const harness = createHarness({
            playerOptions: { remoteAudioMaxBytes: 2 },
            fetch: async (url, requestOptions) => {
                requestOptions.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
                return {
                    ok: true,
                    headers: { get: () => '3' },
                    arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
                };
            }
        });

        await assert.rejects(
            harness.player.play('192.168.1.50', 'https://audio.example.test/large.mp3', 50),
            /exceeds.*limit/i
        );
        assert.equal(aborted, true);
        assert.equal(harness.calls.some((call) => call[0] === 'Mp3.fromBuffer'), false);
    });

    await t.test('abortable timeout', async () => {
        let aborted = false;
        const harness = createHarness({
            playerOptions: { sourceTimeoutMs: 5 },
            fetch: async (url, requestOptions) => new Promise((resolve, reject) => {
                requestOptions.signal.addEventListener('abort', () => {
                    aborted = true;
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            })
        });

        await assert.rejects(
            harness.player.play('192.168.1.50', 'https://audio.example.test/slow.mp3', 50),
            /audio source timed out/i
        );
        assert.equal(aborted, true);
        assert.equal(harness.player.activeCount, 0);
    });
});

test('cleanup failures do not mask successful playback or leak active sessions', async () => {
    const harness = createHarness({
        stopStreamError: new Error('stop failed'),
        sourceStopError: new Error('source stop failed'),
        disconnectError: new Error('disconnect failed')
    });

    await harness.player.play(
        '192.168.1.50',
        '/srv/tts-storage/cache/voice.mp3',
        50
    );

    assert.equal(harness.calls.some((call) => call[0] === 'media.stopStreamAudio'), true);
    assert.equal(harness.calls.some((call) => call[0] === 'source.stop'), true);
    assert.equal(harness.calls.some((call) => call[0] === 'disconnect'), true);
    assert.equal(harness.player.activeCount, 0);
});

test('playGroup starts the master and additional HomePods with independent sources and volumes', async () => {
    const harness = createHarness({ uniqueSources: true });

    const result = await harness.player.playGroup(
        { host: '192.168.1.50', volume: 35 },
        [
            { host: '192.168.1.51', volume: 20 },
            { host: '192.168.1.52', volume: 80 }
        ],
        '/srv/tts-storage/cache/group.mp3'
    );

    assert.deepEqual(
        harness.deviceCalls.filter((call) => call[0] === 'HomePod'),
        [
            ['HomePod', '192.168.1.50'],
            ['HomePod', '192.168.1.51'],
            ['HomePod', '192.168.1.52']
        ]
    );
    assert.deepEqual(
        harness.deviceCalls.filter((call) => call[0] === 'volume.set'),
        [
            ['volume.set', '192.168.1.50', 0.35],
            ['volume.set', '192.168.1.51', 0.2],
            ['volume.set', '192.168.1.52', 0.8]
        ]
    );

    const streamCalls = harness.deviceCalls.filter((call) => call[0] === 'media.streamAudio');
    assert.equal(streamCalls.length, 3);
    assert.equal(new Set(streamCalls.map((call) => call[2])).size, 3);
    assert.deepEqual(result.master, { host: '192.168.1.50', volume: 35 });
    assert.deepEqual(result.masterResult, {
        status: 'completed',
        target: '192.168.1.50'
    });
    assert.deepEqual(
        result.additionalResults.map((item) => [item.status, item.target.host, item.target.volume]),
        [
            ['fulfilled', '192.168.1.51', 20],
            ['fulfilled', '192.168.1.52', 80]
        ]
    );
});

test('playGroup serializes only decoder warm-up and waits for every source before streaming', async () => {
    let activeDecodes = 0;
    let completedDecodes = 0;
    let decoderReady = false;
    let maxConcurrentDecodes = 0;
    let streamStarts = 0;
    const harness = createHarness({
        fileFromPath: async (source, createUniqueSource) => {
            activeDecodes += 1;
            maxConcurrentDecodes = Math.max(maxConcurrentDecodes, activeDecodes);
            if (!decoderReady && activeDecodes > 1) throw new Error('decoder cold start raced');
            await new Promise((resolve) => setTimeout(resolve, decoderReady ? 5 : 2));
            decoderReady = true;
            activeDecodes -= 1;
            completedDecodes += 1;
            return createUniqueSource('local');
        },
        streamAudio: async () => {
            streamStarts += 1;
            assert.equal(completedDecodes, 3, 'no group stream may start before every source is ready');
        }
    });

    const result = await harness.player.playGroup(
        { host: 'master.local', volume: 50 },
        [
            { host: 'left.local', volume: 50 },
            { host: 'right.local', volume: 50 }
        ],
        '/srv/tts-storage/cache/group.mp3'
    );

    assert.equal(maxConcurrentDecodes, 2, 'decoding should become parallel after the one-time warm-up');
    assert.equal(streamStarts, 3);
    assert.deepEqual(result.additionalResults.map((item) => item.status), ['fulfilled', 'fulfilled']);
});

test('playGroup waits for a slower additional volume state before a short master stream', async () => {
    const states = new Map();
    ['master.local', 'additional.local'].forEach((target) => {
        const state = new EventEmitter();
        state.outputDeviceUID = null;
        state.volumeAvailable = false;
        state.volumeCapabilities = 0;
        states.set(target, state);
    });
    const streamTargets = [];
    const harness = createHarness({
        connect: async (device) => {
            const target = device.options.address;
            const state = states.get(target);
            setTimeout(() => {
                state.outputDeviceUID = target + '-cluster';
                state.volumeAvailable = true;
                state.volumeCapabilities = 2;
                state.emit('deviceInfo');
                state.emit('volumeControlAvailability');
            }, target === 'master.local' ? 1 : 30);
        },
        streamAudio: async (source, device) => {
            streamTargets.push(device.options.address);
        },
        volumeStateForDevice: (target) => states.get(target),
        playerOptions: { volumeReadyTimeoutMs: 100 }
    });

    const result = await harness.player.playGroup(
        { host: 'master.local', volume: 50 },
        [{ host: 'additional.local', volume: 50 }],
        '/srv/tts-storage/cache/short.mp3'
    );

    assert.deepEqual(streamTargets.sort(), ['additional.local', 'master.local']);
    assert.deepEqual(result.additionalResults.map((item) => item.status), ['fulfilled']);
});

test('playGroup streams only the master when two addresses resolve to one stereo output', async () => {
    const states = new Map();
    ['stereo-right.local', 'stereo-left.local'].forEach((target) => {
        const state = new EventEmitter();
        state.outputDeviceUID = 'shared-stereo-cluster';
        state.volumeAvailable = true;
        state.volumeCapabilities = 2;
        states.set(target, state);
    });
    const streamTargets = [];
    const harness = createHarness({
        streamAudio: async (source, device) => {
            streamTargets.push(device.options.address);
        },
        volumeStateForDevice: (target) => states.get(target),
        playerOptions: { volumeReadyTimeoutMs: 100 }
    });

    const result = await harness.player.playGroup(
        { host: 'stereo-right.local', volume: 50 },
        [{ host: 'stereo-left.local', volume: 50 }],
        '/srv/tts-storage/cache/stereo.mp3'
    );

    assert.deepEqual(streamTargets, ['stereo-right.local']);
    assert.deepEqual(
        harness.deviceCalls.filter((call) => call[0] === 'volume.set'),
        [['volume.set', 'stereo-right.local', 0.5]],
        'the duplicate must not overwrite the master stereo-pair volume'
    );
    assert.deepEqual(
        result.additionalResults.map((item) => [item.status, item.reason]),
        [['skipped', 'same-output-group']]
    );
});

test('playGroup deduplicates a stereo descriptor before outputDeviceUID becomes active', async () => {
    const states = new Map();
    ['stereo-right.local', 'stereo-left.local'].forEach((target) => {
        const state = new EventEmitter();
        state.outputDeviceUID = null;
        state.outputDevices = [{ uniqueIdentifier: 'shared-stereo-descriptor' }];
        state.volumeAvailable = false;
        state.volumeCapabilities = 0;
        states.set(target, state);
    });
    const streamTargets = [];
    const harness = createHarness({
        streamAudio: async (source, device) => {
            streamTargets.push(device.options.address);
        },
        volumeStateForDevice: (target) => states.get(target),
        playerOptions: { volumeReadyTimeoutMs: 1000 }
    });

    const result = await harness.player.playGroup(
        { host: 'stereo-right.local', volume: 50 },
        [{ host: 'stereo-left.local', volume: 50 }],
        '/srv/tts-storage/cache/stereo.mp3'
    );

    assert.deepEqual(streamTargets, ['stereo-right.local']);
    assert.deepEqual(
        harness.deviceCalls.filter((call) => call[0] === 'volume.setForDevice'),
        [['volume.setForDevice', 'stereo-right.local', 'shared-stereo-descriptor', 0.5]],
        'the duplicate must not overwrite the descriptor-addressed master volume'
    );
    assert.deepEqual(
        result.additionalResults.map((item) => [item.status, item.reason]),
        [['skipped', 'same-output-group']]
    );
});

test('playGroup waits for a shared stereo UID instead of comparing physical receiver psi values', async () => {
    const states = new Map();
    ['stereo-right.local', 'stereo-left.local'].forEach((target) => {
        const state = new EventEmitter();
        state.outputDeviceUID = null;
        state.outputDevices = [];
        state.volumeAvailable = false;
        state.volumeCapabilities = 0;
        states.set(target, state);
    });
    const streamTargets = [];
    const harness = createHarness({
        connect: async (device) => {
            const state = states.get(device.options.address);
            setTimeout(() => {
                state.outputDeviceUID = 'shared-delayed-stereo-cluster';
                state.emit('deviceInfo');
            }, 15);
        },
        receiverInfoForDevice: (target) => ({ psi: target + '-physical-psi' }),
        streamAudio: async (source, device) => {
            streamTargets.push(device.options.address);
        },
        volumeStateForDevice: (target) => states.get(target),
        playerOptions: { volumeReadyTimeoutMs: 100 }
    });

    const result = await harness.player.playGroup(
        { host: 'stereo-right.local', volume: 50 },
        [{ host: 'stereo-left.local', volume: 50 }],
        '/srv/tts-storage/cache/stereo.mp3'
    );

    assert.deepEqual(streamTargets, ['stereo-right.local']);
    assert.deepEqual(
        harness.deviceCalls.filter((call) => call[0] === 'volume.setForDevice'),
        [['volume.setForDevice', 'stereo-right.local', 'shared-delayed-stereo-cluster', 0.5]],
        'only the master may set volume after the delayed stereo identity is known'
    );
    assert.deepEqual(
        result.additionalResults.map((item) => [item.status, item.reason]),
        [['skipped', 'same-output-group']]
    );
});

test('output barrier refreshes a timed-out physical psi when the shared stereo UID arrives', async () => {
    const states = new Map();
    ['stereo-right.local', 'stereo-left.local'].forEach((target) => {
        const state = new EventEmitter();
        state.outputDeviceUID = null;
        state.outputDevices = [];
        state.volumeAvailable = false;
        state.volumeCapabilities = 0;
        states.set(target, state);
    });
    const streamTargets = [];
    const harness = createHarness({
        connect: async (device) => {
            if (device.options.address === 'stereo-right.local') {
                setTimeout(() => {
                    states.forEach((state) => {
                        state.outputDeviceUID = 'shared-late-stereo-cluster';
                        state.emit('deviceInfo');
                    });
                }, 35);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 15));
        },
        receiverInfoForDevice: (target) => ({ psi: target + '-physical-psi' }),
        streamAudio: async (source, device) => {
            streamTargets.push(device.options.address);
        },
        volumeStateForDevice: (target) => states.get(target),
        playerOptions: { volumeReadyTimeoutMs: 25 }
    });

    const result = await harness.player.playGroup(
        { host: 'stereo-right.local', volume: 80 },
        [{ host: 'stereo-left.local', volume: 20 }],
        '/srv/tts-storage/cache/stereo.mp3'
    );

    assert.deepEqual(streamTargets, ['stereo-right.local']);
    assert.deepEqual(
        harness.deviceCalls.filter((call) => call[0] === 'volume.setForDevice'),
        [['volume.setForDevice', 'stereo-right.local', 'shared-late-stereo-cluster', 0.8]],
        'the master must re-resolve the shared UID and remain the only volume owner'
    );
    assert.deepEqual(
        result.additionalResults.map((item) => [item.status, item.reason]),
        [['skipped', 'same-output-group']]
    );
});

test('separate AirPlay player instances share the process-wide decoder warm-up', async () => {
    const bothStreamsStarted = deferred();
    let activeColdStarts = 0;
    let decoderReady = false;
    let streamStarts = 0;
    const harness = createHarness({
        fileFromPath: async (source, createUniqueSource) => {
            if (!decoderReady) {
                activeColdStarts += 1;
                if (activeColdStarts > 1) throw new Error('process-wide decoder warm-up raced');
                await new Promise((resolve) => setTimeout(resolve, 3));
                decoderReady = true;
                activeColdStarts -= 1;
            }
            return createUniqueSource('local');
        },
        streamAudio: async () => {
            streamStarts += 1;
            if (streamStarts === 2) bothStreamsStarted.resolve();
            return bothStreamsStarted.promise;
        }
    });
    const secondPlayer = createAirPlayPlayer({
        allowedLocalRoot: '/srv/tts-storage',
        connectTimeoutMs: 0,
        loadModules: async () => harness.modules,
        playbackTimeoutMs: 0,
        sourceTimeoutMs: 0,
        volumeTimeoutMs: 0
    });

    await Promise.all([
        harness.player.play('first.local', '/srv/tts-storage/cache/group.mp3', 50),
        secondPlayer.play('second.local', '/srv/tts-storage/cache/group.mp3', 50)
    ]);

    assert.equal(streamStarts, 2);
    assert.equal(activeColdStarts, 0);
});

test('playGroup ignores blank, master, and duplicate additional targets case-insensitively', async () => {
    const harness = createHarness();

    const result = await harness.player.playGroup(
        { host: ' Kitchen.LOCAL ', volume: 50 },
        [
            { host: '' },
            { host: '   ' },
            { host: 'kitchen.local', volume: 10 },
            { host: ' Hall.local ', volume: 25 },
            { host: 'HALL.LOCAL', volume: 75 }
        ],
        '/srv/tts-storage/cache/group.mp3'
    );

    assert.deepEqual(
        harness.deviceCalls.filter((call) => call[0] === 'HomePod'),
        [
            ['HomePod', 'Kitchen.LOCAL'],
            ['HomePod', 'Hall.local']
        ]
    );
    assert.deepEqual(result.additionalResults.map((item) => item.target), [
        { host: 'Hall.local', volume: 25 }
    ]);
});

test('playGroup returns an additional-player error without rejecting the master lifecycle', async () => {
    const masterFinished = deferred();
    const additionalFailed = deferred();
    const harness = createHarness({
        streamAudio: async (source, device) => {
            const target = device.options.address;
            if (target === 'master.local') return masterFinished.promise;
            if (target === 'broken.local') {
                additionalFailed.resolve();
                throw new Error('additional RTP failed');
            }
        }
    });

    const groupPlayback = harness.player.playGroup(
        { host: 'master.local', volume: 45 },
        [
            { host: 'working.local', volume: 30 },
            { host: 'broken.local', volume: 60 }
        ],
        '/srv/tts-storage/cache/group.mp3'
    );
    await additionalFailed.promise;
    masterFinished.resolve();

    const result = await groupPlayback;
    const working = result.additionalResults.find((item) => item.target.host === 'working.local');
    const broken = result.additionalResults.find((item) => item.target.host === 'broken.local');
    assert.equal(working.status, 'fulfilled');
    assert.equal(broken.status, 'rejected');
    assert.match(broken.reason.message, /additional RTP failed/);
});

test('playGroup completion follows the master and stops a slow additional player after bounded cleanup', async () => {
    const masterFinished = deferred();
    const slowFinished = deferred();
    const slowStarted = deferred();
    const harness = createHarness({
        streamAudio: async (source, device) => {
            if (device.options.address === 'master.local') return masterFinished.promise;
            slowStarted.resolve();
            return slowFinished.promise;
        },
        playerOptions: {
            backgroundRetryIntervalMs: 1,
            cancelRetryIntervalMs: 1,
            cancelRetryTimeoutMs: 5
        }
    });

    const groupPlayback = harness.player.playGroup(
        { host: 'master.local', volume: 50 },
        [{ host: 'slow.local', volume: 50 }],
        '/srv/tts-storage/cache/group.mp3'
    );
    await slowStarted.promise;
    masterFinished.resolve();

    let timeout;
    const result = await Promise.race([
        groupPlayback,
        new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('group waited indefinitely for an additional player')), 250);
        })
    ]).finally(() => clearTimeout(timeout));

    assert.equal(result.master.host, 'master.local');
    assert.equal(
        harness.deviceCalls.some((call) =>
            call[0] === 'media.stopStreamAudio' && call[1] === 'slow.local'
        ),
        true
    );
    assert.equal(harness.player.activeCount, 1, 'the unsettled SDK stream remains tracked in the background');

    slowFinished.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.player.activeCount, 0);
});

test('playGroup rejects a master error and stops an active additional player', async () => {
    const masterFinished = deferred();
    const additionalFinished = deferred();
    const additionalStarted = deferred();
    const harness = createHarness({
        streamAudio: async (source, device) => {
            if (device.options.address === 'master.local') return masterFinished.promise;
            additionalStarted.resolve();
            return additionalFinished.promise;
        },
        stopStreamAudio: (device) => {
            if (device.options.address === 'additional.local') additionalFinished.resolve();
        }
    });

    const groupPlayback = harness.player.playGroup(
        { host: 'master.local', volume: 50 },
        [{ host: 'additional.local', volume: 50 }],
        '/srv/tts-storage/cache/group.mp3'
    );
    await additionalStarted.promise;
    const rejected = assert.rejects(groupPlayback, /master stream failed/);
    masterFinished.reject(new Error('master stream failed'));
    await rejected;

    assert.equal(
        harness.deviceCalls.some((call) =>
            call[0] === 'media.stopStreamAudio' && call[1] === 'additional.local'
        ),
        true
    );
    assert.equal(harness.player.activeCount, 0);
});

test('playGroup reports an explicit master stop instead of a natural completion', async () => {
    const masterFinished = deferred();
    const additionalFinished = deferred();
    const masterStarted = deferred();
    const additionalStarted = deferred();
    const harness = createHarness({
        streamAudio: async (source, device) => {
            if (device.options.address === 'master.local') {
                masterStarted.resolve();
                return masterFinished.promise;
            }
            additionalStarted.resolve();
            return additionalFinished.promise;
        },
        stopStreamAudio: (device) => {
            if (device.options.address === 'master.local') masterFinished.resolve();
            if (device.options.address === 'additional.local') additionalFinished.resolve();
        }
    });

    const groupPlayback = harness.player.playGroup(
        { host: 'master.local', volume: 50 },
        [{ host: 'additional.local', volume: 50 }],
        '/srv/tts-storage/cache/group.mp3'
    );
    await Promise.all([masterStarted.promise, additionalStarted.promise]);

    const stopping = harness.player.stop();
    const result = await groupPlayback;
    await stopping;

    assert.deepEqual(result.masterResult, {
        reason: 'user',
        status: 'stopped',
        target: 'master.local'
    });
    assert.equal(harness.player.activeCount, 0);
});

test('stopScope only stops its matching sessions while stop remains global', async () => {
    const firstFinished = deferred();
    const secondFinished = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const scopeA = Symbol('scope-a');
    const scopeB = Symbol('scope-b');
    const harness = createHarness({
        streamAudio: async (source, device) => {
            if (device.options.address === 'first.local') {
                firstStarted.resolve();
                return firstFinished.promise;
            }
            secondStarted.resolve();
            return secondFinished.promise;
        },
        stopStreamAudio: (device) => {
            if (device.options.address === 'first.local') firstFinished.resolve();
            if (device.options.address === 'second.local') secondFinished.resolve();
        }
    });

    const firstPlayback = harness.player.play(
        'first.local',
        '/srv/tts-storage/cache/group.mp3',
        50,
        { scope: scopeA }
    );
    const secondPlayback = harness.player.play(
        'second.local',
        '/srv/tts-storage/cache/group.mp3',
        50,
        { scope: scopeB }
    );
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    await harness.player.stopScope(scopeA);
    await firstPlayback;
    assert.equal(
        harness.deviceCalls.some((call) =>
            call[0] === 'media.stopStreamAudio' && call[1] === 'first.local'
        ),
        true
    );
    assert.equal(
        harness.deviceCalls.some((call) =>
            call[0] === 'media.stopStreamAudio' && call[1] === 'second.local'
        ),
        false
    );
    assert.equal(harness.player.activeCount, 1);

    await harness.player.stop();
    await secondPlayback;
    assert.equal(
        harness.deviceCalls.some((call) =>
            call[0] === 'media.stopStreamAudio' && call[1] === 'second.local'
        ),
        true
    );
    assert.equal(harness.player.activeCount, 0);
});
