'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BACKGROUND_RETRY_INTERVAL_MS = 250;
const DEFAULT_CANCEL_RETRY_INTERVAL_MS = 50;
const DEFAULT_CANCEL_RETRY_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 45000;
const DEFAULT_PLAYBACK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RAOP_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_REMOTE_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_SOURCE_TIMEOUT_MS = 45000;
const DEFAULT_STALE_TARGET_TIMEOUT_MS = 5000;
const DEFAULT_VOLUME_TIMEOUT_MS = 10000;
const DEFAULT_VOLUME_READY_TIMEOUT_MS = 1500;
const DEFAULT_VOLUME_RETRY_INTERVAL_MS = 100;

let modulesPromise;
const decoderWarmupStates = new WeakMap();

function loadModules() {
    if (!modulesPromise) {
        modulesPromise = Promise.all([
            import('@basmilius/apple-sdk'),
            import('@basmilius/apple-audio-source'),
            import('@basmilius/apple-raop'),
            import('@basmilius/apple-common')
        ]).then(([sdk, audio, raop, common]) => ({ sdk, audio, raop, common }));
    }
    return modulesPromise;
}

function clampVolume(volume) {
    const parsed = Number(volume);
    if (Number.isNaN(parsed)) return 50;
    return Math.max(0, Math.min(100, parsed));
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
}

function validateAudioSource(source, allowedLocalRoot) {
    const configuredSource = String(source || '').trim();
    if (!configuredSource) throw new Error('AirPlay: no audio source provided');
    if (isHttpUrl(configuredSource)) return configuredSource;

    if (!allowedLocalRoot) {
        throw new Error('AirPlay: local audio root is not configured');
    }

    let resolvedRoot = path.resolve(String(allowedLocalRoot));
    let resolvedSource = path.resolve(configuredSource);
    let isInsideRoot = resolvedSource.startsWith(resolvedRoot + path.sep);
    const isMp3 = path.extname(resolvedSource).toLowerCase() === '.mp3';

    // Resolve existing paths as well, so a symlink inside the cache cannot point
    // File.fromPath() at an MP3 outside the configured storage folder.
    if (isInsideRoot && fs.existsSync(resolvedRoot) && fs.existsSync(resolvedSource)) {
        const realpath = fs.realpathSync.native || fs.realpathSync;
        resolvedRoot = realpath(resolvedRoot);
        resolvedSource = realpath(resolvedSource);
        isInsideRoot = resolvedSource.startsWith(resolvedRoot + path.sep);
    }
    if (!isInsideRoot || !isMp3) {
        throw new Error('AirPlay: local audio source is not an MP3 inside the configured storage folder');
    }

    return resolvedSource;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUnref(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function') timer.unref();
    });
}

function stoppedError() {
    const error = new Error('AirPlay playback stopped');
    error.code = 'AIRPLAY_STOPPED';
    return error;
}

function createStartBarrier(expectedParticipants) {
    let expected = Math.max(0, Number(expectedParticipants) || 0);
    let released = expected === 0;
    let resolveRelease;
    const arrived = new Set();
    const withdrawn = new Set();
    const releasePromise = released ? Promise.resolve() : new Promise((resolve) => {
        resolveRelease = resolve;
    });

    function releaseIfReady() {
        if (!released && arrived.size >= expected) {
            released = true;
            resolveRelease();
        }
    }

    return {
        arrive(participant) {
            if (!released && !withdrawn.has(participant)) {
                arrived.add(participant);
                releaseIfReady();
            }
            return releasePromise;
        },
        withdraw(participant) {
            if (released || withdrawn.has(participant)) return;
            withdrawn.add(participant);
            arrived.delete(participant);
            expected = Math.max(0, expected - 1);
            releaseIfReady();
        }
    };
}

function createOutputBarrier(expectedParticipants) {
    let expected = Math.max(0, Number(expectedParticipants) || 0);
    let released = expected === 0;
    const participants = new Map();
    const withdrawn = new Set();

    function releaseIfReady() {
        if (released || participants.size < expected) return;
        released = true;
        const winners = new Map();
        const resolvedKeys = new Map();

        participants.forEach((entry, participant) => {
            let outputKey;
            try {
                outputKey = typeof entry.key === 'function' ? entry.key() : entry.key;
            } catch (error) {
                outputKey = '';
            }
            const resolvedKey = String(outputKey || participant.target || '').trim().toLowerCase();
            resolvedKeys.set(participant, resolvedKey);
            const current = winners.get(resolvedKey);
            if (!current || (participant.role === 'master' && current.role !== 'master')) {
                winners.set(resolvedKey, participant);
            }
        });
        participants.forEach((entry, participant) => {
            entry.resolve({ duplicate: winners.get(resolvedKeys.get(participant)) !== participant });
        });
    }

    return {
        arrive(participant, outputKey) {
            if (withdrawn.has(participant)) return Promise.resolve({ duplicate: true });
            if (released) return Promise.resolve({ duplicate: false });
            const existing = participants.get(participant);
            if (existing) return existing.promise;

            let resolveParticipant;
            const promise = new Promise((resolve) => { resolveParticipant = resolve; });
            participants.set(participant, {
                key: outputKey,
                promise,
                resolve: resolveParticipant
            });
            releaseIfReady();
            return promise;
        },
        withdraw(participant) {
            if (released || withdrawn.has(participant)) return;
            withdrawn.add(participant);
            const entry = participants.get(participant);
            if (entry) {
                participants.delete(participant);
                entry.resolve({ duplicate: true });
            }
            expected = Math.max(0, expected - 1);
            releaseIfReady();
        }
    };
}

function isExpectedStop(session, error) {
    return error && error.code === 'AIRPLAY_STOPPED' &&
        (session.stopReason === 'user' || session.stopReason === 'group-complete');
}

function requestStop(session, reason) {
    if (session.stopped) return;

    session.stopped = true;
    session.stopReason = reason;
    session.stopError = stoppedError();
    if (session.sourceAbortController) session.sourceAbortController.abort();
    Array.from(session.cancelHandlers).forEach((cancel) => cancel(session.stopError));
}

function awaitOperation(session, promise, options) {
    const opts = options || {};

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            session.cancelHandlers.delete(cancel);
            callback(value);
        };
        const cancel = (error) => finish(reject, error);

        session.cancelHandlers.add(cancel);
        if (session.stopped) {
            cancel(session.stopError || stoppedError());
            return;
        }

        if (opts.timeoutMs && opts.timeoutMs > 0) {
            timer = setTimeout(() => {
                const error = new Error(opts.timeoutMessage || 'AirPlay operation timed out');
                if (typeof opts.onTimeout === 'function') {
                    try { opts.onTimeout(); } catch (timeoutError) { }
                }
                finish(reject, error);
                if (opts.stopOnTimeout !== false) requestStop(session, 'timeout');
            }, opts.timeoutMs);
        }

        Promise.resolve(promise).then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error)
        );
    });
}

function responseHeader(response, name) {
    if (!response || !response.headers || typeof response.headers.get !== 'function') return null;
    return response.headers.get(name);
}

async function readResponseWithLimit(response, maxBytes) {
    const declaredLength = Number(responseHeader(response, 'content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error('remote MP3 exceeds the ' + maxBytes + ' byte limit');
    }

    if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const item = await reader.read();
                if (item.done) break;
                const chunk = Buffer.from(item.value);
                total += chunk.length;
                if (total > maxBytes) {
                    try { await reader.cancel(); } catch (error) { }
                    throw new Error('remote MP3 exceeds the ' + maxBytes + ' byte limit');
                }
                chunks.push(chunk);
            }
        } finally {
            if (typeof reader.releaseLock === 'function') reader.releaseLock();
        }

        const buffer = Buffer.allocUnsafeSlow(total);
        let offset = 0;
        chunks.forEach((chunk) => {
            chunk.copy(buffer, offset);
            offset += chunk.length;
        });
        return buffer;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
        throw new Error('remote MP3 exceeds the ' + maxBytes + ' byte limit');
    }
    const buffer = Buffer.allocUnsafeSlow(arrayBuffer.byteLength);
    Buffer.from(arrayBuffer).copy(buffer);
    return buffer;
}

async function createRemoteMp3(audio, url, fetchImpl, signal, maxBytes) {
    if (typeof fetchImpl !== 'function') throw new Error('AirPlay: HTTP fetch is unavailable');

    const response = await fetchImpl(url, { signal });
    if (!response || !response.ok) {
        try {
            if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel();
        } catch (error) { }
        const status = response ? String(response.status || '') + ' ' + String(response.statusText || '') : 'no response';
        throw new Error('failed to fetch remote MP3: ' + status.trim());
    }
    try {
        const buffer = await readResponseWithLimit(response, maxBytes);
        return await audio.Mp3.fromBuffer(buffer);
    } catch (error) {
        try {
            if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
        } catch (cancelError) { }
        throw error;
    }
}

function createAirPlayPlayer(options) {
    const opts = options || {};
    const activeSessions = new Set();
    const getModules = opts.loadModules || loadModules;
    const logger = opts.logger || {};
    const fetchImpl = opts.fetch || globalThis.fetch;
    const backgroundRetryIntervalMs = opts.backgroundRetryIntervalMs === undefined ? DEFAULT_BACKGROUND_RETRY_INTERVAL_MS : opts.backgroundRetryIntervalMs;
    const cancelRetryIntervalMs = opts.cancelRetryIntervalMs === undefined ? DEFAULT_CANCEL_RETRY_INTERVAL_MS : opts.cancelRetryIntervalMs;
    const cancelRetryTimeoutMs = opts.cancelRetryTimeoutMs === undefined ? DEFAULT_CANCEL_RETRY_TIMEOUT_MS : opts.cancelRetryTimeoutMs;
    const connectTimeoutMs = opts.connectTimeoutMs === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : opts.connectTimeoutMs;
    const sourceTimeoutMs = opts.sourceTimeoutMs === undefined ? DEFAULT_SOURCE_TIMEOUT_MS : opts.sourceTimeoutMs;
    const playbackTimeoutMs = opts.playbackTimeoutMs === undefined ? DEFAULT_PLAYBACK_TIMEOUT_MS : opts.playbackTimeoutMs;
    const raopCacheTtlMs = opts.raopCacheTtlMs === undefined ? DEFAULT_RAOP_CACHE_TTL_MS : opts.raopCacheTtlMs;
    const remoteAudioMaxBytes = opts.remoteAudioMaxBytes === undefined ? DEFAULT_REMOTE_AUDIO_MAX_BYTES : opts.remoteAudioMaxBytes;
    const volumeTimeoutMs = opts.volumeTimeoutMs === undefined ? DEFAULT_VOLUME_TIMEOUT_MS : opts.volumeTimeoutMs;
    const volumeReadyTimeoutMs = opts.volumeReadyTimeoutMs === undefined ? DEFAULT_VOLUME_READY_TIMEOUT_MS : opts.volumeReadyTimeoutMs;
    const volumeRetryIntervalMs = opts.volumeRetryIntervalMs === undefined ? DEFAULT_VOLUME_RETRY_INTERVAL_MS : opts.volumeRetryIntervalMs;
    const staleTargetTimeoutMs = opts.staleTargetTimeoutMs === undefined ? DEFAULT_STALE_TARGET_TIMEOUT_MS : opts.staleTargetTimeoutMs;
    const raopTargets = new Map();

    function warn(message) {
        if (typeof logger.warn === 'function') logger.warn(message);
    }

    function ensureActive(session) {
        if (session.stopped) throw session.stopError || stoppedError();
    }

    function normalizeTarget(value) {
        return String(value || '').trim().toLowerCase().replace(/\.$/, '');
    }

    function raopResultTargets(result) {
        if (!result) return [];
        return [
            result.address,
            result.id,
            result.fqdn,
            result.familyName,
            result.name,
            result.txt && result.txt.name
        ].map(normalizeTarget).filter(Boolean);
    }

    function raopStrongIdentities(result) {
        if (!result) return [];
        return Array.from(new Set([result.id, result.fqdn]
            .map(normalizeTarget)
            .filter(Boolean)));
    }

    function raopHardwareIdentity(value) {
        const normalized = normalizeTarget(value);
        if (normalized.startsWith('raop-device:')) {
            return normalizeHardwareAddress(normalized.slice('raop-device:'.length));
        }
        const separatorIndex = normalized.indexOf('@');
        if (separatorIndex <= 0) return '';
        const hardwareId = normalized.slice(0, separatorIndex).replace(/[^a-f0-9]/g, '');
        return /^[a-f0-9]{12}$/.test(hardwareId) ? hardwareId : '';
    }

    function raopResultHardwareIdentities(result) {
        return Array.from(new Set(raopStrongIdentities(result)
            .map(raopHardwareIdentity)
            .filter(Boolean)));
    }

    function normalizeHardwareAddress(value) {
        const hardwareId = String(value || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
        return /^[a-f0-9]{12}$/.test(hardwareId) ? hardwareId : '';
    }

    function raopClientMatchesDiscoveryIdentity(client, discoveryResult) {
        const expected = raopResultHardwareIdentities(discoveryResult);
        if (expected.length === 0) return false;

        const info = client && client.info || {};
        const actual = [
            info.deviceID,
            info.deviceId,
            info.deviceid,
            info.macAddress,
            info.macaddress
        ].map(normalizeHardwareAddress).filter(Boolean);
        return actual.some((identity) => expected.includes(identity));
    }

    function isUsableRaopResult(result) {
        const service = result && result.service || {};
        return /^_raop\._tcp(?:\.local)?$/i.test(String(service.type || '')) &&
            Number.isInteger(Number(service.port)) && Number(service.port) > 0;
    }

    function raopResultMatchesTarget(result, target) {
        const normalizedTarget = normalizeTarget(target);
        if (!normalizedTarget || !isUsableRaopResult(result)) return false;

        const targetHardwareId = raopHardwareIdentity(normalizedTarget);
        if (targetHardwareId && raopResultHardwareIdentities(result).includes(targetHardwareId)) return true;

        const candidates = raopResultTargets(result);
        return candidates.some((candidate) => candidate === normalizedTarget ||
            candidate.replace(/\.local$/, '') === normalizedTarget.replace(/\.local$/, '') ||
            candidate.split('@').pop().replace(/\.local$/, '') === normalizedTarget.replace(/\.local$/, ''));
    }

    function matchPreviousRaopResult(results, previous) {
        const previousStrongIdentities = raopStrongIdentities(previous);
        const previousHardwareIdentities = raopResultHardwareIdentities(previous);

        const exactMatch = results.find((result) =>
            raopStrongIdentities(result).some((identity) => previousStrongIdentities.includes(identity))
        );
        if (exactMatch) return exactMatch;

        if (previousHardwareIdentities.length > 0) {
            return results.find((result) =>
                raopResultHardwareIdentities(result).some((identity) =>
                    previousHardwareIdentities.includes(identity)
                )
            ) || null;
        }

        return null;
    }

    function getCachedRaopTarget(cacheKey) {
        const cached = raopTargets.get(cacheKey);
        if (!cached) return null;
        if (cached.expiresAt <= Date.now()) {
            raopTargets.delete(cacheKey);
            return null;
        }
        return cached.result;
    }

    function cacheRaopTarget(cacheKey, result) {
        if (!(raopCacheTtlMs > 0)) return;
        raopTargets.set(cacheKey, {
            expiresAt: Date.now() + raopCacheTtlMs,
            result
        });
    }

    async function resolveRaopTarget(common, target, resolveOptions) {
        const resolveOpts = resolveOptions || {};
        const cacheKey = normalizeTarget(target);
        const cached = !resolveOpts.refresh && getCachedRaopTarget(cacheKey);
        if (cached) return { fromCache: true, result: cached };

        if (typeof opts.resolveRaopTarget === 'function') {
            const resolved = await opts.resolveRaopTarget(target, {
                previous: resolveOpts.previous || null,
                refresh: Boolean(resolveOpts.refresh)
            });
            if (!resolved) throw new Error('AirPlay: RAOP service not found for ' + target);
            cacheRaopTarget(cacheKey, resolved);
            return { fromCache: false, result: resolved };
        }

        // Keep successful descriptors briefly so consecutive files in one
        // announcement do not each pay for a multicast scan. Expired or failed
        // entries force a fresh lookup instead of trusting an old DHCP lease.
        const discovered = await common.Discovery.raop().find(false);
        const results = (Array.isArray(discovered) ? discovered : []).filter(isUsableRaopResult);
        const resolved = resolveOpts.previous ?
            matchPreviousRaopResult(results, resolveOpts.previous) :
            results.find((result) => raopResultMatchesTarget(result, target));
        if (!resolved) throw new Error('AirPlay: RAOP service not found for ' + target);

        cacheRaopTarget(cacheKey, resolved);
        return { fromCache: false, result: resolved };
    }

    function applyRaopTarget(session, resolution) {
        const discoveryResult = resolution.result;
        session.raopDiscoveryResult = discoveryResult;
        session.raopTargetFromCache = Boolean(resolution.fromCache);
        session.address = String(discoveryResult && discoveryResult.address || session.target).trim();
        return discoveryResult;
    }

    async function ensureRaopTarget(session, modules) {
        if (session.raopDiscoveryResult) return session.raopDiscoveryResult;
        const resolution = await resolveRaopTarget(modules.common, session.target);
        return applyRaopTarget(session, resolution);
    }

    async function refreshRaopTarget(session, modules, previous) {
        raopTargets.delete(normalizeTarget(session.target));
        const resolution = await resolveRaopTarget(modules.common, session.target, {
            previous,
            refresh: true
        });
        return applyRaopTarget(session, resolution);
    }

    async function createRaopClient(session, modules, discoveryResult, timingServer, timeoutMs) {
        let abandoned = false;
        let createPromise;
        try {
            createPromise = Promise.resolve(modules.raop.RaopClient.create(discoveryResult, timingServer));
        } catch (error) {
            createPromise = Promise.reject(error);
        }
        createPromise.then((lateClient) => {
            if (!abandoned || !lateClient) return;
            try {
                Promise.resolve(lateClient.close()).catch(() => { });
            } catch (error) { }
        }, () => { });

        try {
            return await awaitOperation(session, createPromise, {
                timeoutMs,
                timeoutMessage: 'AirPlay: stale RAOP endpoint timed out for ' + session.target,
                stopOnTimeout: false
            });
        } catch (error) {
            abandoned = true;
            throw error;
        }
    }

    async function prepareRaopStream(session, modules) {
        let client;
        const timingServer = new modules.common.TimingServer();
        session.timingServer = timingServer;
        try {
            await timingServer.listen();
            ensureActive(session);
            let discoveryResult = await ensureRaopTarget(session, modules);

            // A HomePod can keep the same mDNS identity while DHCP changes its
            // address. Try the cached descriptor first, then do exactly one fresh
            // lookup matched by exact RAOP identity or hardware prefix before
            // failing this announcement.
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    ensureActive(session);
                    const cachedAttemptTimeoutMs = attempt === 0 && session.raopTargetFromCache ?
                        staleTargetTimeoutMs : 0;
                    client = await createRaopClient(
                        session,
                        modules,
                        discoveryResult,
                        timingServer,
                        cachedAttemptTimeoutMs
                    );
                    // create() is not abortable. If stop/timeout won while the RTSP
                    // handshake was pending, close this late client in the catch below.
                    ensureActive(session);
                    if (attempt === 0 && session.raopTargetFromCache &&
                        !raopClientMatchesDiscoveryIdentity(client, discoveryResult)) {
                        const identityError = new Error(
                            'AirPlay: cached RAOP identity could not be verified for ' + session.target
                        );
                        identityError.code = 'AIRPLAY_STALE_TARGET';
                        throw identityError;
                    }
                    session.raopClient = client;
                    session.transport = 'raop';
                    return;
                } catch (error) {
                    if (client) {
                        try { await client.close(); } catch (closeError) { }
                        client = null;
                    }
                    if (attempt > 0 || session.stopped) throw error;
                    discoveryResult = await refreshRaopTarget(session, modules, discoveryResult);
                }
            }
        } catch (error) {
            raopTargets.delete(normalizeTarget(session.target));
            if (client) {
                try { await client.close(); } catch (closeError) { }
            }
            timingServer.close();
            session.timingServer = null;
            throw error;
        }
    }

    async function discardPreparedRaop(session) {
        if (session.raopClient) {
            try { await session.raopClient.close(); } catch (error) { }
            session.raopClient = null;
        }
        if (session.timingServer) {
            try { session.timingServer.close(); } catch (error) { }
            session.timingServer = null;
        }
        session.raopClosed = false;
        session.transport = 'sdk';
    }

    async function connectControlDevice(session, modules, usesRaop) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const address = session.address || session.target;
            // Without a TimingServer, the SDK uses timingProtocol=None.
            if (!usesRaop && modules.common && !session.timingServer) {
                session.timingServer = new modules.common.TimingServer();
                await awaitOperation(session, session.timingServer.listen(), {
                    timeoutMs: connectTimeoutMs,
                    timeoutMessage: 'AirPlay: NTP timing server timed out'
                });
            }
            const connectingDevice = new modules.sdk.HomePod({
                address,
                ...(!usesRaop && session.timingServer ? { timingServer: session.timingServer } : {})
            });
            session.device = connectingDevice;
            session.deviceDisconnected = false;

            const connectPromise = Promise.resolve(connectingDevice.connect());
            // connect() is not abortable. If stop/timeout wins the race, its first
            // disconnect may run before the SDK finishes connecting; disconnect again
            // on a late success so feedback timers/sockets cannot escape tracking.
            connectPromise.then(() => {
                if (!session.stopped && !session.released && session.device === connectingDevice) return;
                try { connectingDevice.disconnect(); } catch (error) { }
            }, () => { });

            try {
                const staleCachedAttempt = usesRaop && attempt === 0 &&
                    session.raopTargetFromCache && staleTargetTimeoutMs > 0;
                await awaitOperation(session, connectPromise, {
                    timeoutMs: staleCachedAttempt ? staleTargetTimeoutMs : connectTimeoutMs,
                    timeoutMessage: 'AirPlay: connection timed out for ' + session.target,
                    stopOnTimeout: !staleCachedAttempt
                });
                return;
            } catch (error) {
                try { connectingDevice.disconnect(); } catch (disconnectError) { }
                if (session.device === connectingDevice) session.device = null;
                if (!usesRaop || attempt > 0 || session.stopped) throw error;

                const previous = session.raopDiscoveryResult;
                await discardPreparedRaop(session);
                await awaitOperation(session, refreshRaopTarget(session, modules, previous), {
                    timeoutMs: connectTimeoutMs,
                    timeoutMessage: 'AirPlay: RAOP rediscovery timed out for ' + session.target
                });
                ensureActive(session);
            }
        }
    }

    async function awaitVolumeOperation(session, promise, timeoutMs, timeoutMessage) {
        const result = await new Promise((resolve) => {
            let settled = false;
            let timer;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                session.cancelHandlers.delete(cancel);
                resolve(value);
            };
            const cancel = (error) => finish({ error, status: 'rejected' });

            session.cancelHandlers.add(cancel);
            if (session.stopped) {
                cancel(session.stopError || stoppedError());
                return;
            }
            if (timeoutMs > 0) {
                timer = setTimeout(() => finish({
                    error: new Error(timeoutMessage),
                    status: 'rejected'
                }), timeoutMs);
            }

            Promise.resolve(promise).then(
                (value) => finish({ status: 'fulfilled', value }),
                (error) => finish({ error, status: 'rejected' })
            );
            session.streamSettledPromise.then(() => finish({ status: 'stream-settled' }));
        });
        if (result.status === 'rejected') throw result.error;
        return result;
    }

    function volumeControlIsReady(session, sdk) {
        const state = session.device && session.device.airplay && session.device.airplay.state;
        const capabilities = sdk && sdk.Proto && sdk.Proto.VolumeCapabilities_Enum;
        if (!state || !state.outputDeviceUID) return false;
        if (capabilities) {
            return state.volumeCapabilities === capabilities.Absolute ||
                state.volumeCapabilities === capabilities.Both;
        }
        return Boolean(state.volumeAvailable);
    }

    function resolveStateOutputDeviceUID(session) {
        const state = session.device && session.device.airplay && session.device.airplay.state;
        if (state && state.outputDeviceUID) return String(state.outputDeviceUID);
        if (state && Array.isArray(state.outputDevices) && state.outputDevices.length === 1) {
            const descriptor = state.outputDevices[0] || {};
            const descriptorUID = descriptor.clusterID || descriptor.uniqueIdentifier ||
                descriptor.primaryUID || descriptor.deviceUID;
            if (descriptorUID) return String(descriptorUID);
        }
        return '';
    }

    function resolveOutputDeviceUID(session) {
        const stateUID = resolveStateOutputDeviceUID(session);
        if (stateUID) return stateUID;
        const device = session.device;
        const info = device && device.receiverInfo || {};
        return String(info.psi || info.pi || '').trim();
    }

    function waitForOutputIdentity(session) {
        const state = session.device && session.device.airplay && session.device.airplay.state;
        const timeoutMs = Math.max(0, volumeReadyTimeoutMs);
        if (resolveStateOutputDeviceUID(session) || !state ||
            typeof state.on !== 'function' || timeoutMs === 0) {
            return Promise.resolve(resolveStateOutputDeviceUID(session));
        }

        return new Promise((resolve) => {
            const events = ['deviceInfo', 'deviceInfoUpdate', 'updateOutputDevice', 'clusterChanged'];
            let settled = false;
            let timer;
            const removeListener = typeof state.off === 'function' ?
                (event, listener) => state.off(event, listener) :
                (event, listener) => state.removeListener(event, listener);
            const finish = () => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                events.forEach((event) => removeListener(event, check));
                session.cancelHandlers.delete(cancel);
                resolve(resolveStateOutputDeviceUID(session));
            };
            const check = () => {
                if (resolveStateOutputDeviceUID(session)) finish();
            };
            const cancel = () => finish();

            events.forEach((event) => state.on(event, check));
            session.cancelHandlers.add(cancel);
            if (session.stopped) {
                cancel();
                return;
            }
            timer = setTimeout(finish, timeoutMs);
            check();
        });
    }

    function setVolumeCommand(session, sdk, volume) {
        const uid = resolveOutputDeviceUID(session);
        if (!volumeControlIsReady(session, sdk) && uid &&
            typeof session.device.volume.setForDevice === 'function') {
            return session.device.volume.setForDevice(uid, clampVolume(volume) / 100);
        }
        return session.device.volume.set(clampVolume(volume) / 100);
    }

    function unmuteCommand(session, sdk) {
        const uid = resolveOutputDeviceUID(session);
        if (!volumeControlIsReady(session, sdk) && uid &&
            typeof session.device.volume.unmuteDevice === 'function') {
            return session.device.volume.unmuteDevice(uid);
        }
        if (session.device.volume && typeof session.device.volume.unmute === 'function') {
            return session.device.volume.unmute();
        }
        return null;
    }

    function waitForVolumeControlReady(session, sdk) {
        const state = session.device && session.device.airplay && session.device.airplay.state;
        const timeoutMs = Math.max(0, volumeReadyTimeoutMs);
        if (!state || typeof state.on !== 'function' || timeoutMs === 0) {
            return Promise.resolve(volumeControlIsReady(session, sdk));
        }

        const isReady = () => volumeControlIsReady(session, sdk);
        if (isReady()) return Promise.resolve(true);

        return new Promise((resolve) => {
            const events = [
                'deviceInfo',
                'deviceInfoUpdate',
                'volumeControlAvailability',
                'volumeControlCapabilitiesDidChange'
            ];
            let settled = false;
            let timer;
            const removeListener = typeof state.off === 'function' ?
                (event, listener) => state.off(event, listener) :
                (event, listener) => state.removeListener(event, listener);
            const finish = (ready) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                events.forEach((event) => removeListener(event, check));
                session.cancelHandlers.delete(cancel);
                resolve(ready);
            };
            const check = () => {
                if (isReady()) finish(true);
            };
            const cancel = () => finish(false);

            events.forEach((event) => state.on(event, check));
            session.cancelHandlers.add(cancel);
            if (session.stopped) {
                cancel();
                return;
            }
            timer = setTimeout(() => finish(false), timeoutMs);
            check();
        });
    }

    async function setVolumeBeforeStream(session, sdk, volume) {
        const explicitUID = resolveOutputDeviceUID(session);
        const canAddressExplicitly = Boolean(explicitUID &&
            typeof session.device.volume.setForDevice === 'function');
        const stateReady = volumeControlIsReady(session, sdk) ||
            (!canAddressExplicitly && await waitForVolumeControlReady(session, sdk));
        if (!stateReady && !canAddressExplicitly) return false;
        if (session.stopped) return false;

        try {
            await awaitOperation(
                session,
                Promise.resolve(setVolumeCommand(session, sdk, volume)),
                {
                    timeoutMs: Math.max(1, volumeReadyTimeoutMs),
                    timeoutMessage: 'AirPlay: pre-stream volume request timed out for ' + session.target,
                    stopOnTimeout: false
                }
            );
            const unmutePromise = unmuteCommand(session, sdk);
            if (unmutePromise) {
                await awaitOperation(
                    session,
                    Promise.resolve(unmutePromise),
                    {
                        timeoutMs: Math.max(1, volumeReadyTimeoutMs),
                        timeoutMessage: 'AirPlay: pre-stream unmute request timed out for ' + session.target,
                        stopOnTimeout: false
                    }
                );
            }
            return true;
        } catch (error) {
            // The stream-first retry below remains the fallback for delayed state,
            // transient command errors, and older SDK/device combinations.
            return false;
        }
    }

    async function setVolumeWhenOutputIsActive(session, sdk, volume) {
        const deadline = Date.now() + Math.max(0, volumeTimeoutMs);
        let lastUnmuteError;
        let lastVolumeError;
        let unmuted = false;

        // The event-driven pre-stream path above normally handles volume. This is
        // a best-effort fallback when the control session publishes its deviceInfo
        // late or transiently rejects the first command. The SDK uses a separate
        // protocol for audio, so streaming itself does not guarantee MRP readiness.
        do {
            if (session.stopped || session.streamSettled) return false;
            let volumeApplied = false;
            try {
                const remaining = Math.max(1, deadline - Date.now());
                const volumeResult = await awaitVolumeOperation(
                    session,
                    Promise.resolve(setVolumeCommand(session, sdk, volume)),
                    remaining,
                    'AirPlay: volume request timed out for ' + session.target
                );
                if (volumeResult.status === 'stream-settled') return false;
                volumeApplied = true;
            } catch (error) {
                if (error.code === 'AIRPLAY_STOPPED' || session.stopped) return false;
                lastVolumeError = error;
            }

            // Absolute volume and mute are separate commands. Some HomePod/SDK
            // combinations reject volume.set() but still accept unmute(), so do not
            // leave an already-muted speaker silent just because volume is unavailable.
            if (!unmuted && session.device.volume) {
                try {
                    const unmutePromise = unmuteCommand(session, sdk);
                    if (!unmutePromise) {
                        unmuted = true;
                    } else {
                        const unmuteResult = await awaitVolumeOperation(
                            session,
                            Promise.resolve(unmutePromise),
                            Math.max(1, deadline - Date.now()),
                            'AirPlay: unmute request timed out for ' + session.target
                        );
                        if (unmuteResult.status === 'stream-settled') return volumeApplied;
                        unmuted = true;
                    }
                } catch (error) {
                    if (error.code === 'AIRPLAY_STOPPED' || session.stopped) return false;
                    lastUnmuteError = error;
                }
            }

            if (volumeApplied) {
                if (lastUnmuteError && !unmuted) {
                    warn('AirPlay: unable to unmute ' + session.target + ': ' + lastUnmuteError.message);
                }
                return true;
            }

            if (session.streamSettled || Date.now() >= deadline) break;
            await Promise.race([
                session.streamSettledPromise,
                wait(Math.min(Math.max(1, volumeRetryIntervalMs), Math.max(1, deadline - Date.now())))
            ]);
        } while (!session.streamSettled && Date.now() < deadline);

        if (lastVolumeError && !session.stopped) {
            warn('AirPlay: unable to set volume on ' + session.target + ': ' + lastVolumeError.message);
        }
        if (lastUnmuteError && !unmuted && !session.stopped) {
            warn('AirPlay: unable to unmute ' + session.target + ': ' + lastUnmuteError.message);
        }
        return false;
    }

    function cleanupPass(session) {
        const run = async () => {
            const device = session.device;
            try {
                if (session.raopClient) session.raopClient.stop();
                else if (device && device.media) device.media.stopStreamAudio();
            } catch (error) { }

            if (session.sourceAbortController) {
                try { session.sourceAbortController.abort(); } catch (error) { }
            }

            if (session.source && !session.sourceStopped &&
                (!session.raopClient || !session.streamStarted || session.streamSettled)) {
                session.sourceStopped = true;
                try {
                    if (typeof session.source.stop === 'function') await session.source.stop();
                } catch (error) { }
            }

            // RaopClient.stream() tears down its RTSP session in its own finally.
            // Do not disconnect underneath that teardown while cancellation is still
            // settling; close the client and its NTP server only after the stream ends.
            if (session.raopClient &&
                (!session.streamStarted || session.streamSettled) &&
                !session.raopClosed) {
                session.raopClosed = true;
                try { await session.raopClient.close(); } catch (error) { }
                session.raopClient = null;
            }
            if (session.timingServer &&
                (!session.streamStarted || session.streamSettled) &&
                !session.raopClient) {
                try { session.timingServer.close(); } catch (error) { }
                session.timingServer = null;
            }

            if (device && !session.deviceDisconnected) {
                session.deviceDisconnected = true;
                try {
                    if (typeof device.disconnect === 'function') device.disconnect();
                } catch (error) { }
            }
        };

        const next = session.cleanupChain.then(run, run);
        session.cleanupChain = next.catch(() => { });
        return next;
    }

    function releaseSession(session) {
        if (session.released) return;
        session.released = true;
        session.device = null;
        session.source = null;
        activeSessions.delete(session);
    }

    function startBackgroundStop(session) {
        if (session.backgroundStopPromise || !session.streamStarted || session.streamSettled) return;

        session.backgroundStopPromise = (async () => {
            while (session.stopped && !session.streamSettled) {
                await cleanupPass(session);
                if (session.streamSettled) break;
                await waitUnref(Math.max(1, backgroundRetryIntervalMs));
            }
            await cleanupPass(session);
        })().finally(() => {
            session.backgroundStopPromise = null;
        });
    }

    function stopSession(session) {
        if (session.stopPromise) return session.stopPromise;

        session.stopPromise = (async () => {
            const deadline = Date.now() + Math.max(0, cancelRetryTimeoutMs);
            do {
                await cleanupPass(session);
                if (!session.streamStarted || session.streamSettled) break;

                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                await Promise.race([
                    session.streamSettledPromise,
                    wait(Math.min(Math.max(1, cancelRetryIntervalMs), remaining))
                ]);
            } while (!session.streamSettled);

            await cleanupPass(session);
            if (session.streamStarted && !session.streamSettled) startBackgroundStop(session);
        })().finally(() => {
            session.stopPromise = null;
        });

        return session.stopPromise;
    }

    async function createSource(audio, source, session) {
        const validatedSource = validateAudioSource(source, opts.allowedLocalRoot);
        if (!isHttpUrl(validatedSource)) return audio.File.fromPath(validatedSource);

        const controller = new AbortController();
        session.sourceAbortController = controller;
        try {
            return await createRemoteMp3(audio, validatedSource, fetchImpl, controller.signal, remoteAudioMaxBytes);
        } catch (error) {
            controller.abort();
            throw error;
        } finally {
            if (session.sourceAbortController === controller) session.sourceAbortController = null;
        }
    }

    function createSourceAfterDecoderWarmup(audio, source, session) {
        // apple-audio-source lazily initializes a process-wide WASM decoder and that
        // cold start is not concurrency-safe. Use the imported audio module as a
        // process-wide key so separate TTS Ultimate nodes share the same warm-up.
        let state = decoderWarmupStates.get(audio);
        if (!state) {
            state = { ready: false, warmup: null };
            decoderWarmupStates.set(audio, state);
        }

        if (state.ready) {
            return Promise.resolve().then(() => {
                ensureActive(session);
                return createSource(audio, source, session);
            });
        }

        if (state.warmup) {
            return state.warmup.then(() => createSourceAfterDecoderWarmup(audio, source, session));
        }

        const sourcePromise = Promise.resolve().then(() => {
            ensureActive(session);
            return createSource(audio, source, session);
        });
        state.warmup = sourcePromise.then(
            () => {
                state.ready = true;
                state.warmup = null;
            },
            () => {
                // A failed/cancelled first source did not prove the decoder is ready.
                // The next waiting session becomes the sole initializer instead.
                state.warmup = null;
            }
        );
        return sourcePromise;
    }

    async function play(target, source, volume, playbackOptions) {
        const playOpts = playbackOptions || {};
        const configuredTarget = String(target || '').trim();
        const configuredSource = String(source || '').trim();
        if (!configuredTarget) throw new Error('AirPlay: no HomePod configured');
        if (!configuredSource) throw new Error('AirPlay: no audio source provided');

        let resolveOuter;
        const session = {
            address: null,
            backgroundStopPromise: null,
            cancelHandlers: new Set(),
            cleanupChain: Promise.resolve(),
            device: null,
            deviceDisconnected: false,
            outerDone: new Promise((resolve) => { resolveOuter = resolve; }),
            outerSettled: false,
            released: false,
            source: null,
            sourceAbortController: null,
            sourceStopped: false,
            raopClient: null,
            raopClosed: false,
            raopDiscoveryResult: null,
            raopTargetFromCache: false,
            scope: playOpts.scope,
            role: playOpts.role || 'single',
            stopError: null,
            stopPromise: null,
            stopReason: null,
            stopped: false,
            streamSettled: true,
            streamSettledPromise: Promise.resolve(),
            streamStarted: false,
            target: configuredTarget,
            timingServer: null,
            transport: 'sdk'
        };
        session.resolveOuter = resolveOuter;
        activeSessions.add(session);
        let outcome = { status: 'completed', target: configuredTarget };

        try {
            const modules = await awaitOperation(session, getModules());
            ensureActive(session);
            const hasRaopDiscovery = Boolean(modules.raop && modules.common);
            const usesRaop = hasRaopDiscovery && opts.transport !== 'airplay2';

            const sourcePromise = createSourceAfterDecoderWarmup(modules.audio, configuredSource, session);
            sourcePromise.then((lateSource) => {
                if (session.stopped && !session.source) {
                    session.source = lateSource;
                    cleanupPass(session).catch(() => { });
                }
            }, () => { });
            session.source = await awaitOperation(session, sourcePromise, {
                timeoutMs: sourceTimeoutMs,
                timeoutMessage: 'AirPlay: audio source timed out for ' + configuredSource,
                onTimeout: () => {
                    if (session.sourceAbortController) session.sourceAbortController.abort();
                }
            });
            ensureActive(session);

            // For a group, prepare every independent source before any HomePod starts.
            // This keeps even a very short announcement from finishing on the master
            // while an additional player is still decoding the same MP3.
            if (playOpts.sourceBarrier) {
                await awaitOperation(session, playOpts.sourceBarrier.arrive(session));
                ensureActive(session);
            }

            // Treat the configured value as a stable mDNS selector. Resolve it to
            // the current address before the optional MRP control connection; the
            // synthetic service-name .local value is not guaranteed to be an OS-
            // resolvable hostname, especially inside containers.
            if (hasRaopDiscovery) {
                await awaitOperation(session, ensureRaopTarget(session, modules), {
                    timeoutMs: connectTimeoutMs,
                    timeoutMessage: 'AirPlay: RAOP discovery timed out for ' + configuredTarget
                });
                ensureActive(session);

                // A grouped cached endpoint must be identity-checked before MRP
                // connects to its address. Otherwise a reassigned lease could make
                // the control plane describe a different HomePod before RAOP gets
                // a chance to invalidate the stale descriptor.
                if (usesRaop && playOpts.streamBarrier && session.raopTargetFromCache) {
                    await awaitOperation(session, prepareRaopStream(session, modules), {
                        timeoutMs: connectTimeoutMs,
                        timeoutMessage: 'AirPlay: RAOP connection timed out for ' + configuredTarget
                    });
                    ensureActive(session);
                }
            }

            // A single RAOP endpoint needs no transient AirPlay/MRP control session:
            // RAOP owns timing and session volume. Keep MRP only for multi-player
            // runs, where its output UID prevents two stereo-pair members from both
            // receiving a stream when an old/manual configuration contains them.
            if (!usesRaop || playOpts.streamBarrier) {
                await connectControlDevice(session, modules, usesRaop);
                ensureActive(session);
            }

            // Resolve duplicate physical addresses before touching volume or audio.
            // receiverInfo.psi identifies one receiver, whereas MRP's output UID
            // identifies the stereo cluster to which it belongs.
            if (playOpts.streamBarrier) {
                await awaitOperation(session, waitForOutputIdentity(session));
                ensureActive(session);
                const streamAdmission = await awaitOperation(
                    session,
                    playOpts.streamBarrier.arrive(session, () => {
                        // Resolve at barrier release, not arrival: another HomePod
                        // may publish the shared cluster while this one is waiting.
                        const outputDeviceUID = resolveOutputDeviceUID(session);
                        return outputDeviceUID ?
                            'output:' + outputDeviceUID :
                            'host:' + (session.address || session.target);
                    })
                );
                ensureActive(session);
                if (streamAdmission && streamAdmission.duplicate) {
                    outcome = {
                        reason: 'same-output-group',
                        status: 'skipped',
                        target: configuredTarget
                    };
                    return outcome;
                }
            }

            // connect() can resolve before its asynchronous deviceInfo and volume
            // capability events arrive. Wait briefly for that documented state and
            // set volume before sending audio, so muted HomePods do not lose the
            // beginning of a short announcement. Stereo duplicates have already
            // exited, therefore only the winning master can change the pair volume.
            const volumeAppliedBeforeStream = usesRaop ?
                true :
                await setVolumeBeforeStream(session, modules.sdk, volume);
            ensureActive(session);

            // RAOP remains the default transport. The opt-in SDK path uses
            // AirPlay 2 with the explicit NTP server passed during connection.
            if (usesRaop && !session.raopClient) {
                await awaitOperation(session, prepareRaopStream(session, modules), {
                    timeoutMs: connectTimeoutMs,
                    timeoutMessage: 'AirPlay: RAOP connection timed out for ' + configuredTarget
                });
                ensureActive(session);
            }

            // Connection and volume readiness complete at different times on each
            // distinct HomePod. Hold the first audio frame until every surviving
            // group participant reaches this point, otherwise a very short master
            // clip can finish and stop a slower additional player.
            if (playOpts.playbackBarrier) {
                await awaitOperation(session, playOpts.playbackBarrier.arrive(session));
                ensureActive(session);
            }

            session.streamStarted = true;
            session.streamSettled = false;
            ensureActive(session);
            let streamPromise;
            try {
                if (usesRaop) {
                    streamPromise = Promise.resolve(session.raopClient.stream(session.source, {
                        volume: clampVolume(volume)
                    })).catch((error) => {
                        raopTargets.delete(normalizeTarget(session.target));
                        throw error;
                    }).finally(() => {
                        // RaopClient owns the AudioSource start/stop lifecycle.
                        session.sourceStopped = true;
                    });
                } else {
                    // Start audio before the fallback retry. The control and streaming
                    // protocols are independent, so this does not imply MRP readiness.
                    streamPromise = Promise.resolve(session.device.media.streamAudio(session.source));
                }
            } catch (error) {
                if (usesRaop) raopTargets.delete(normalizeTarget(session.target));
                streamPromise = Promise.reject(error);
            }
            session.streamSettledPromise = streamPromise.then(() => { }, () => { }).then(async () => {
                session.streamSettled = true;
                if (session.outerSettled) {
                    await cleanupPass(session);
                    releaseSession(session);
                }
            });
            const volumePromise = usesRaop || volumeAppliedBeforeStream ?
                Promise.resolve(true) :
                setVolumeWhenOutputIsActive(session, modules.sdk, volume);

            await awaitOperation(session, streamPromise, {
                timeoutMs: playbackTimeoutMs,
                timeoutMessage: 'AirPlay: playback timed out on ' + configuredTarget
            });
            await volumePromise;
        } catch (error) {
            if (isExpectedStop(session, error)) {
                outcome = { reason: session.stopReason, status: 'stopped', target: configuredTarget };
            } else {
                throw new Error('AirPlay ' + configuredTarget + ': ' + error.message, { cause: error });
            }
        } finally {
            if (playOpts.sourceBarrier) playOpts.sourceBarrier.withdraw(session);
            if (playOpts.streamBarrier) playOpts.streamBarrier.withdraw(session);
            if (playOpts.playbackBarrier) playOpts.playbackBarrier.withdraw(session);
            if (session.stopped && session.stopReason !== 'user') {
                await stopSession(session);
            } else {
                await cleanupPass(session);
            }

            session.outerSettled = true;
            session.resolveOuter();
            if (!session.streamStarted || session.streamSettled) releaseSession(session);
        }

        return outcome;
    }

    async function stopSessions(predicate, reason) {
        const sessions = Array.from(activeSessions).filter(predicate);
        sessions.forEach((session) => requestStop(session, reason));
        await Promise.allSettled(sessions.map(stopSession));
        await Promise.allSettled(sessions.map((session) => session.outerDone));
    }

    async function stopScope(scope) {
        if (scope === undefined || scope === null) return;
        await stopSessions((session) => session.scope === scope, 'group-complete');
    }

    async function playGroup(masterTarget, additionalTargets, source) {
        const master = masterTarget || {};
        const masterHost = String(master.host || '').trim();
        const configuredSource = String(source || '').trim();
        if (!masterHost) throw new Error('AirPlay: no master HomePod configured');
        if (!configuredSource) throw new Error('AirPlay: no audio source provided');

        const seenHosts = new Set([masterHost.toLowerCase()]);
        const additional = [];
        const configuredAdditional = Array.isArray(additionalTargets) ? additionalTargets : [];
        configuredAdditional.forEach((target) => {
            const item = target || {};
            const host = String(item.host || '').trim();
            const key = host.toLowerCase();
            if (!host || seenHosts.has(key)) return;
            seenHosts.add(key);
            additional.push({ host, volume: clampVolume(item.volume) });
        });

        // Each target gets its own HomePod and audio-source instance. The scope lets
        // the master clean up only its companions, without racing a new priority item.
        const scope = Symbol('airplay-group');
        const sourceBarrier = createStartBarrier(1 + additional.length);
        const streamBarrier = additional.length > 0 ?
            createOutputBarrier(1 + additional.length) : null;
        const playbackBarrier = additional.length > 0 ?
            createStartBarrier(1 + additional.length) : null;
        const masterPromise = play(masterHost, configuredSource, clampVolume(master.volume), {
            playbackBarrier,
            role: 'master',
            scope,
            sourceBarrier,
            streamBarrier
        });
        const additionalPromises = additional.map((target) =>
            play(target.host, configuredSource, target.volume, {
                playbackBarrier,
                role: 'additional',
                scope,
                sourceBarrier,
                streamBarrier
            }).then(
                (playResult) => playResult && playResult.status === 'skipped' ?
                    { reason: playResult.reason, status: 'skipped', target } :
                    { status: 'fulfilled', target },
                (reason) => ({ status: 'rejected', target, reason })
            )
        );

        let masterError;
        let masterResult;
        try {
            // The master promise is the sole lifecycle authority for the group.
            masterResult = await masterPromise;
        } catch (error) {
            masterError = error;
        } finally {
            await stopScope(scope);
        }

        const additionalResults = await Promise.all(additionalPromises);
        if (masterError) throw masterError;
        return {
            additionalResults,
            master: { host: masterHost, volume: clampVolume(master.volume) },
            masterResult
        };
    }

    async function stop() {
        await stopSessions(() => true, 'user');
    }

    async function close() {
        await stop();
        if (activeSessions.size > 0) {
            warn('AirPlay: ' + activeSessions.size + ' SDK stream(s) did not settle before the close timeout');
        }
    }

    return {
        play,
        playGroup,
        stop,
        stopScope,
        close,
        get activeCount() {
            return activeSessions.size;
        }
    };
}

module.exports = {
    DEFAULT_BACKGROUND_RETRY_INTERVAL_MS,
    DEFAULT_CANCEL_RETRY_INTERVAL_MS,
    DEFAULT_CANCEL_RETRY_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
    DEFAULT_PLAYBACK_TIMEOUT_MS,
    DEFAULT_RAOP_CACHE_TTL_MS,
    DEFAULT_REMOTE_AUDIO_MAX_BYTES,
    DEFAULT_SOURCE_TIMEOUT_MS,
    DEFAULT_STALE_TARGET_TIMEOUT_MS,
    DEFAULT_VOLUME_TIMEOUT_MS,
    DEFAULT_VOLUME_RETRY_INTERVAL_MS,
    clampVolume,
    createAirPlayPlayer,
    createRemoteMp3,
    isHttpUrl,
    readResponseWithLimit,
    validateAudioSource
};
