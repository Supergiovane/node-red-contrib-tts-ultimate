'use strict';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 6500;

let commonModulePromise;

function loadCommonModule() {
    if (!commonModulePromise) commonModulePromise = import('@basmilius/apple-common');
    return commonModulePromise;
}

function withTimeout(promise, timeoutMs, message) {
    if (!timeoutMs || timeoutMs <= 0) return promise;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        Promise.resolve(promise).then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function isHomePod(result) {
    const model = String(result && (result.modelName || (result.txt && (result.txt.model || result.txt.am))) || '');
    return /^AudioAccessory/i.test(model);
}

function displayName(result) {
    if (result.familyName) return String(result.familyName);
    if (result.txt && result.txt.name) return String(result.txt.name);

    return String(result.id || result.fqdn || result.address || 'HomePod')
        .replace(/\.local$/i, '')
        .replace(/-/g, ' ');
}

function publicDevice(result) {
    const address = String(result.address || '').trim();
    if (!address) return null;

    return {
        name: displayName(result),
        // Store the resolved address so runtime playback can connect immediately,
        // without repeating the four-second mDNS scan for every audio file.
        host: address,
        address: address,
        model: String(result.modelName || (result.txt && (result.txt.model || result.txt.am)) || '')
    };
}

function stereoGroupId(result) {
    return String(result && result.txt && result.txt.tsid || '').trim();
}

function groupLeaderScore(result) {
    const txt = result && result.txt || {};
    if (String(txt.igl || '') === '1') return 3;
    if (String(txt.pgmid || '') === '1') return 2;
    return 1;
}

async function discoverRaw(options) {
    const opts = options || {};
    const common = opts.commonModule || await (opts.loadCommonModule || loadCommonModule)();
    const discovery = opts.discovery || common.Discovery.airplay();
    const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_DISCOVERY_TIMEOUT_MS : opts.timeoutMs;
    const results = await withTimeout(
        discovery.find(opts.useCache !== false),
        timeoutMs,
        'AirPlay discovery timed out'
    );

    return (Array.isArray(results) ? results : []).filter(isHomePod);
}

async function discoverAirPlayDevices(options) {
    const results = await discoverRaw(options);
    const grouped = new Map();

    results.forEach((result) => {
        const address = String(result && result.address || '').trim().toLowerCase();
        if (!address) return;
        const stereoId = stereoGroupId(result);
        const key = stereoId ? 'stereo:' + stereoId.toLowerCase() : 'host:' + address;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(result);
    });

    return Array.from(grouped.values()).reduce((devices, members) => {
        const leader = members.slice().sort((a, b) => groupLeaderScore(b) - groupLeaderScore(a))[0];
        const device = publicDevice(leader);
        if (!device) return devices;

        const stereoId = stereoGroupId(leader);
        if (stereoId && members.length > 1) {
            const groupName = String(leader.txt && leader.txt.gpn || '').trim();
            const memberAddresses = Array.from(new Set(members.map((member) =>
                String(member.address || '').trim()
            ).filter(Boolean)));
            device.name = groupName || displayName(leader).replace(/\s+(Left|Right)$/i, '');
            device.groupId = stereoId;
            device.members = memberAddresses;
        }
        devices.push(device);
        return devices;
    }, []);
}

module.exports = {
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    discoverAirPlayDevices,
    discoverRaw,
    displayName,
    groupLeaderScore,
    isHomePod,
    publicDevice,
    stereoGroupId
};
