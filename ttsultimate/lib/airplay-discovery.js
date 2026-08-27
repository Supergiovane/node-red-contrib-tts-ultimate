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

function isAirPlayResult(result) {
    const service = result && result.service || {};
    return Boolean(String(result && result.address || '').trim()) &&
        /^_airplay\._tcp(?:\.local)?$/i.test(String(service.type || '')) &&
        Number.isInteger(Number(service.port)) && Number(service.port) > 0;
}

function stripRaopHardwarePrefix(value) {
    const name = String(value || '').trim();
    const separatorIndex = name.indexOf('@');
    if (separatorIndex <= 0) return name;

    const hardwareId = normalizeHardwareId(name.slice(0, separatorIndex));
    return hardwareId ? name.slice(separatorIndex + 1).trim() : name;
}

function displayName(result) {
    const familyName = stripRaopHardwarePrefix(result && result.familyName);
    if (familyName) return familyName.replace(/\.local\.?$/i, '');

    const txtName = stripRaopHardwarePrefix(result && result.txt && result.txt.name);
    if (txtName) return txtName.replace(/\.local\.?$/i, '');

    return stripRaopHardwarePrefix(result && (result.id || result.fqdn || result.address) || 'HomePod')
        .replace(/\.local\.?$/i, '')
        .replace(/-/g, ' ');
}

function stableTarget(result, raopResult) {
    const hardwareId = airPlayHardwareId(result) || raopHardwareId(raopResult);
    if (hardwareId) return 'raop-device:' + hardwareId;

    const raopIdentity = String(raopResult && (raopResult.id || raopResult.fqdn) || '')
        .trim().replace(/\.$/, '');
    if (raopIdentity) return raopIdentity;

    return String(result && (result.id || result.fqdn) || '').trim().replace(/\.$/, '') ||
        String(result && result.address || '').trim();
}

function publicDevice(result, raopResult) {
    const address = String(result.address || '').trim();
    if (!address) return null;

    return {
        name: displayName(result),
        // Persist the DNS-SD service identity, not the current DHCP lease. Runtime
        // playback resolves this selector through RAOP mDNS before opening sockets.
        host: stableTarget(result, raopResult),
        address: address,
        model: String(result.modelName || (result.txt && (result.txt.model || result.txt.am)) || '')
    };
}

function stereoGroupId(result) {
    return String(result && result.txt && result.txt.tsid || '').trim();
}

function groupLeaderScore(result) {
    const txt = result && result.txt || {};
    if (String(txt.igl || '') === '1') return 4;
    if (String(txt.pgmid || '') === '1') return 3;
    if (stereoGroupId(result)) return 2;
    return 1;
}

function compareDiscoveryResults(first, second) {
    const firstName = displayName(first);
    const secondName = displayName(second);
    return groupLeaderScore(second) - groupLeaderScore(first) ||
        firstName.length - secondName.length ||
        firstName.localeCompare(secondName, undefined, {
            numeric: true,
            sensitivity: 'base'
        }) ||
        String(first && (first.id || first.fqdn) || '').localeCompare(
            String(second && (second.id || second.fqdn) || '')
        ) ||
        String(first && first.address || '').localeCompare(String(second && second.address || ''));
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

    // apple-common collects every PTR record contained in an mDNS response,
    // including additional RAOP records. Filter by service type as well as model
    // so the UI receives only the human-readable AirPlay advertisement and not a
    // second "AABBCCDDEEFF@Name" entry for the same HomePod.
    return (Array.isArray(results) ? results : [])
        .filter((result) => isAirPlayResult(result) && isHomePod(result));
}

function isRaopResult(result) {
    const service = result && result.service || {};
    return Boolean(String(result && result.address || '').trim()) &&
        /^_raop\._tcp(?:\.local)?$/i.test(String(service.type || '')) &&
        Number.isInteger(Number(service.port)) && Number(service.port) > 0;
}

function normalizeHardwareId(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
    return /^[a-f0-9]{12}$/.test(normalized) ? normalized : '';
}

function airPlayHardwareId(result) {
    const txt = result && result.txt || {};
    return normalizeHardwareId(txt.deviceid || txt.deviceId || txt.deviceID);
}

function raopHardwareId(result) {
    const identity = String(result && (result.id || result.fqdn) || '');
    const separatorIndex = identity.indexOf('@');
    return separatorIndex > 0 ? normalizeHardwareId(identity.slice(0, separatorIndex)) : '';
}

function correlatedRaopResult(result, raopByAddress) {
    const address = String(result && result.address || '').trim().toLowerCase();
    const candidates = raopByAddress.get(address) || [];
    if (candidates.length === 0) return null;

    const hardwareId = airPlayHardwareId(result);
    if (hardwareId) {
        const hardwareMatches = candidates.filter((candidate) => raopHardwareId(candidate) === hardwareId);
        return hardwareMatches.length === 1 ? hardwareMatches[0] : null;
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function discoveryIdentity(result) {
    return {
        address: String(result && result.address || '').trim().toLowerCase(),
        hardwareId: airPlayHardwareId(result),
        serviceIds: Array.from(new Set([
            result && result.id,
            result && result.fqdn
        ].map((value) => String(value || '').trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))),
        stereoId: stereoGroupId(result).toLowerCase()
    };
}

function discoveryGroupMatchScore(group, identity) {
    if (identity.stereoId && group.stereoIds.has(identity.stereoId)) return 4;
    if (identity.hardwareId && group.hardwareIds.has(identity.hardwareId)) return 3;

    // Never merge two known physical receivers merely because stale mDNS data
    // reports the same address after a DHCP lease was reassigned.
    if (identity.hardwareId && group.hardwareIds.size > 0) return -1;
    if (identity.serviceIds.some((serviceId) => group.serviceIds.has(serviceId))) return 2;
    if (identity.stereoId && group.stereoIds.size > 0) return -1;

    return identity.address && group.addresses.has(identity.address) ? 1 : 0;
}

function setsIntersect(first, second) {
    return Array.from(first).some((value) => second.has(value));
}

function discoveryGroupsAreCompatible(first, second) {
    if (setsIntersect(first.stereoIds, second.stereoIds)) return true;
    if (setsIntersect(first.hardwareIds, second.hardwareIds)) return true;
    if (first.hardwareIds.size > 0 && second.hardwareIds.size > 0) return false;
    if (first.stereoIds.size > 0 && second.stereoIds.size > 0) return false;
    return true;
}

function mergeDiscoveryGroups(target, source) {
    source.members.forEach((member) => target.members.push(member));
    source.addresses.forEach((address) => target.addresses.add(address));
    source.hardwareIds.forEach((hardwareId) => target.hardwareIds.add(hardwareId));
    source.serviceIds.forEach((serviceId) => target.serviceIds.add(serviceId));
    source.stereoIds.forEach((stereoId) => target.stereoIds.add(stereoId));
}

function groupDiscoveredHomePods(results) {
    const groups = [];

    results.forEach((result) => {
        const identity = discoveryIdentity(result);
        const matches = groups.map((group) => ({
            group,
            score: discoveryGroupMatchScore(group, identity)
        })).filter((match) => match.score > 0).sort((a, b) => b.score - a.score);
        let group = matches.length > 0 ? matches[0].group : null;

        if (!group) {
            group = {
                addresses: new Set(),
                hardwareIds: new Set(),
                members: [],
                serviceIds: new Set(),
                stereoIds: new Set()
            };
            groups.push(group);
        }

        group.members.push(result);
        if (identity.address) group.addresses.add(identity.address);
        if (identity.hardwareId) group.hardwareIds.add(identity.hardwareId);
        identity.serviceIds.forEach((serviceId) => group.serviceIds.add(serviceId));
        if (identity.stereoId) group.stereoIds.add(identity.stereoId);

        matches.slice(1).forEach((match) => {
            const other = match.group;
            if (!groups.includes(other) || !discoveryGroupsAreCompatible(group, other)) return;
            mergeDiscoveryGroups(group, other);
            groups.splice(groups.indexOf(other), 1);
        });
    });

    return groups.map((group) => group.members);
}

function shouldDiscoverRaop(options) {
    const opts = options || {};
    if (opts.discoverRaop === false) return false;
    if (opts.raopDiscovery) return true;
    if (opts.commonModule) {
        return Boolean(opts.commonModule.Discovery &&
            typeof opts.commonModule.Discovery.raop === 'function');
    }
    // An injected AirPlay discovery is normally a focused unit/integration test.
    // Do not unexpectedly open a second real multicast socket beside it.
    return !opts.discovery;
}

async function discoverRaopRaw(options) {
    const opts = options || {};
    if (!shouldDiscoverRaop(opts)) return [];
    const common = opts.commonModule || await (opts.loadCommonModule || loadCommonModule)();
    const discovery = opts.raopDiscovery || common.Discovery.raop();
    const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_DISCOVERY_TIMEOUT_MS : opts.timeoutMs;
    const results = await withTimeout(
        discovery.find(opts.useCache !== false),
        timeoutMs,
        'RAOP discovery timed out'
    );
    return (Array.isArray(results) ? results : []).filter(isRaopResult);
}

async function discoverAirPlayDevices(options) {
    const opts = options || {};
    const [results, raopResults] = await Promise.all([
        discoverRaw(opts),
        discoverRaopRaw(opts).catch(() => [])
    ]);
    const raopByAddress = new Map();
    raopResults.forEach((result) => {
        const address = String(result.address || '').trim().toLowerCase();
        if (!address) return;
        if (!raopByAddress.has(address)) raopByAddress.set(address, []);
        raopByAddress.get(address).push(result);
    });
    const devices = groupDiscoveredHomePods(results).reduce((foundDevices, members) => {
        const orderedMembers = members.slice().sort(compareDiscoveryResults);
        const leader = orderedMembers[0];
        const device = publicDevice(leader, correlatedRaopResult(leader, raopByAddress));
        if (!device) return foundDevices;

        const stereoId = stereoGroupId(leader);
        if (stereoId && orderedMembers.length > 1) {
            const groupName = String(leader.txt && leader.txt.gpn || '').trim();
            const memberAddresses = Array.from(new Set(orderedMembers.map((member) =>
                String(member.address || '').trim()
            ).filter(Boolean)));
            const memberHosts = Array.from(new Set(orderedMembers.map((member) => {
                return stableTarget(member, correlatedRaopResult(member, raopByAddress));
            }).filter(Boolean)));
            device.name = groupName || displayName(leader).replace(/\s+(Left|Right)$/i, '');
            device.groupId = stereoId;
            device.members = memberAddresses;
            device.memberHosts = memberHosts;
        }
        foundDevices.push(device);
        return foundDevices;
    }, []);

    return devices.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, {
            numeric: true,
            sensitivity: 'base'
        }) || String(a.address || '').localeCompare(String(b.address || ''))
    );
}

module.exports = {
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    discoverAirPlayDevices,
    discoverRaopRaw,
    discoverRaw,
    displayName,
    groupLeaderScore,
    groupDiscoveredHomePods,
    isAirPlayResult,
    isHomePod,
    isRaopResult,
    publicDevice,
    stableTarget,
    stereoGroupId
};
