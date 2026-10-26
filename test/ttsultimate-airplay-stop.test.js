'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate, description, timeoutMs = 3500) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${description}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function closeNode(node) {
    return new Promise((resolve) => node.emit('close', resolve));
}

for (const playerType of ['airplay', 'airplay2', 'airplayraop']) {
    test(playerType + ' stop keeps a stale queue invalidated and locked until player cleanup finishes', { timeout: 10000 }, async (t) => {
        const runtimePath = require.resolve('../ttsultimate/ttsultimate');
        const airPlayModule = require('../ttsultimate/lib/airplay-player');
        const originalCreateAirPlayPlayer = airPlayModule.createAirPlayPlayer;
        const playbackCalls = [];
        const stopCleanup = createDeferred();
        let stopCalls = 0;

        const fakeAirPlayPlayer = {
            playGroup(master, additional, source) {
                const completion = createDeferred();
                playbackCalls.push({ master, additional, source, completion });
                return completion.promise;
            },
            stop() {
                stopCalls += 1;
                return stopCleanup.promise;
            },
            close() {
                return Promise.resolve();
            }
        };

        let playerOptions;
        airPlayModule.createAirPlayPlayer = (options) => {
            playerOptions = options;
            return fakeAirPlayPlayer;
        };
        delete require.cache[runtimePath];

        const sent = [];
        const statuses = [];
        const server = {
            TTSRootFolderPath: '/tmp/ttsultimate-runtime-stop-test',
            ttsCacheFolder: '/tmp/ttsultimate-runtime-stop-test/cache',
            sNoderedURL: 'http://127.0.0.1:1880',
            whoIsUsingTheServer: '',
            ttsservice: 'googletranslate'
        };
        let NodeConstructor;
        const RED = {
            settings: { userDir: '/tmp/ttsultimate-runtime-stop-test' },
            log: { error() {}, info() {}, warn() {} },
            util: { cloneMessage: (message) => ({ ...message }) },
            nodes: {
                createNode(node) {
                    const emitter = new EventEmitter();
                    node.id = 'airplay-stop-node';
                    node.on = emitter.on.bind(emitter);
                    node.emit = emitter.emit.bind(emitter);
                    node.send = (messages) => sent.push(messages);
                    node.status = (status) => statuses.push(status);
                },
                getNode: () => server,
                registerType(name, constructor) {
                    if (name === 'ttsultimate') NodeConstructor = constructor;
                }
            }
        };

        require(runtimePath)(RED);
        const node = new NodeConstructor({
            config: 'tts-config',
            playertype: playerType,
            playeripaddress: 'master.local',
            playervolume: '40',
            sonosipaddress: '',
            sonosvolume: '40',
            sonoshailing: '0',
            voice: 'it',
            rules: []
        });

        assert.equal(playerOptions.transport, playerType === 'airplayraop' ? 'raop' : 'airplay2');

        t.after(async () => {
            stopCleanup.resolve();
            for (const call of playbackCalls) {
                call.completion.resolve({ masterResult: { status: 'stopped' }, additionalResults: [] });
            }
            await closeNode(node);
            airPlayModule.createAirPlayPlayer = originalCreateAirPlayPlayer;
            delete require.cache[runtimePath];
        });

        const firstSource = 'https://example.test/first.mp3';
        const secondSource = 'https://example.test/second.mp3';
        node.emit('input', {
            payload: firstSource,
            setConfig: {
                setMainPlayerIP: 'runtime-master.local',
                setPlayerGroupArray: ['extra-one.local#-10', 'extra-two.local#20']
            }
        });
        await waitFor(() => playbackCalls.length === 1, 'the first AirPlay playback');
        assert.deepEqual(playbackCalls[0].master, { host: 'runtime-master.local', volume: 40 });
        assert.deepEqual(playbackCalls[0].additional, [
            { host: 'extra-one.local', volume: 30 },
            { host: 'extra-two.local', volume: 60 }
        ]);

        node.emit('input', { stop: true });
        node.emit('input', { payload: secondSource });
        assert.equal(stopCalls, 1);
        assert.equal(node.stopInProgress, true);

        // Let the old HandleQueue return while stop() is still cleaning up the SDK.
        playbackCalls[0].completion.resolve({
            masterResult: { status: 'stopped' },
            additionalResults: []
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.equal(node.bBusyPlayingQueue, true);
        assert.equal(server.whoIsUsingTheServer, node.id);
        assert.equal(sent.some((messages) => messages[0] && messages[0].payload === true), false);
        assert.equal(statuses.some((status) => status.text.includes(`End playing ${firstSource}`)), false);

        // Cross a complete queue-watcher interval: the queued second message must not
        // start until the asynchronous AirPlay cleanup has released the playback lock.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(playbackCalls.length, 1);
        assert.equal(node.stopInProgress, true);

        stopCleanup.resolve();
        await waitFor(() => playbackCalls.length === 2, 'the second AirPlay playback after cleanup', 3000);
        assert.equal(node.stopInProgress, false);
        assert.equal(playbackCalls[1].source, secondSource);
        assert.equal(
            sent.filter((messages) => messages[0] && messages[0].payload === true).length,
            1,
            'the stopped queue completes only after cleanup'
        );

        playbackCalls[1].completion.resolve({
            masterResult: { status: 'completed' },
            additionalResults: []
        });
        await waitFor(
            () => sent.filter((messages) => messages[0] && messages[0].payload === true).length === 2,
            'the second queue completion'
        );
        assert.equal(statuses.some((status) => status.text.includes(`End playing ${secondSource}`)), true);

        // A priority item must also cancel a phrase that is still waiting for TTS,
        // before an AirPlay session exists for stop() to terminate.
        await waitFor(() => node.bBusyPlayingQueue === false, 'the second queue lock release');
        const synthesisStarted = createDeferred();
        const synthesisFinished = createDeferred();
        server.googleTranslateTTS = {
            synthesize() {
                synthesisStarted.resolve();
                return synthesisFinished.promise;
            }
        };
        const callsBeforePriority = playbackCalls.length;
        const prioritySource = 'https://example.test/priority.mp3';
        node.emit('input', { payload: 'This superseded phrase still needs synthesis.' });
        await synthesisStarted.promise;
        node.emit('input', { payload: prioritySource, priority: true, volume: 65 });
        synthesisFinished.resolve(Buffer.from([0x49, 0x44, 0x33]));

        await waitFor(
            () => playbackCalls.length === callsBeforePriority + 1,
            'the priority AirPlay playback'
        );
        assert.equal(playbackCalls.at(-1).source, prioritySource);
        assert.equal(playbackCalls.at(-1).master.volume, 65);
        playbackCalls.at(-1).completion.resolve({
            masterResult: { status: 'completed' },
            additionalResults: []
        });
        await waitFor(
            () => statuses.some((status) => status.text.includes(`End playing ${prioritySource}`)),
            'the priority queue completion'
        );

        // Only a master failure is promoted to the public error output.
        await waitFor(() => node.bBusyPlayingQueue === false, 'the priority queue lock release');
        const failedSource = 'https://example.test/master-failure.mp3';
        node.emit('input', { payload: failedSource });
        await waitFor(
            () => playbackCalls.at(-1).source === failedSource,
            'the failing master playback'
        );
        playbackCalls.at(-1).completion.reject(new Error('master connection failed'));
        await waitFor(
            () => sent.some((messages) => messages[1] &&
                messages[1].payload === true &&
                messages[1].error === 'master connection failed'),
            'the master error output'
        );
    });
}
