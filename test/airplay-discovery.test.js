'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    discoverAirPlayDevices,
    discoverRaw,
    displayName,
    isHomePod
} = require('../ttsultimate/lib/airplay-discovery');

function homePod(overrides) {
    return Object.assign({
        id: 'Living-Room.local',
        fqdn: 'Living-Room.local',
        address: '192.168.1.31',
        familyName: 'Living Room',
        modelName: 'AudioAccessory6,1',
        service: { type: '_airplay._tcp.local', port: 7000 },
        txt: {
            features: '0x4A7FCA00,0xBC354BD0',
            model: 'AudioAccessory6,1'
        },
        // The vendor SDK exposes this as bigint.  The admin endpoint must never
        // leak it into res.json(), where JSON.stringify would throw.
        features: 1n << 46n
    }, overrides);
}

test('discoverAirPlayDevices returns JSON-safe HomePods with stable mDNS selectors', async () => {
    const raw = [
        homePod(),
        homePod({
            id: 'Kitchen-Pod.local',
            fqdn: 'Kitchen-Pod.local',
            address: '192.168.1.32',
            familyName: null,
            modelName: '',
            txt: { name: 'Kitchen Pod', am: 'AudioAccessory5,1' }
        }),
        // Apple TVs also advertise _airplay._tcp but cannot use the transient
        // HomePod connection path used by this player.
        homePod({
            id: 'Apple-TV.local',
            fqdn: 'Apple-TV.local',
            address: '192.168.1.40',
            familyName: 'Apple TV',
            modelName: 'AppleTV14,1',
            txt: { model: 'AppleTV14,1' }
        }),
        // Same device announced twice under different service ids.
        homePod({
            id: 'Living-Room-duplicate.local',
            address: '192.168.1.31',
            familyName: 'Duplicate Living Room'
        }),
        // A service without a usable network address must not be offered.
        homePod({
            id: 'Broken-Pod.local',
            fqdn: 'Broken-Pod.local',
            address: '',
            familyName: 'Broken Pod'
        })
    ];

    const devices = await discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: { find: async () => raw }
    });

    assert.deepEqual(devices, [
        {
            name: 'Kitchen Pod',
            host: 'Kitchen-Pod.local',
            address: '192.168.1.32',
            model: 'AudioAccessory5,1'
        },
        {
            name: 'Living Room',
            host: 'Living-Room.local',
            address: '192.168.1.31',
            model: 'AudioAccessory6,1'
        }
    ]);
    assert.doesNotThrow(() => JSON.stringify(devices));
});

test('the persisted HomePod selector stays unchanged across a DHCP address change', async () => {
    const discoverAt = async (address) => discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: { find: async () => [homePod({ address })] }
    });

    const beforeRestart = await discoverAt('192.168.1.31');
    const afterRestart = await discoverAt('192.168.1.87');

    assert.equal(beforeRestart[0].host, 'Living-Room.local');
    assert.equal(afterRestart[0].host, beforeRestart[0].host);
    assert.equal(beforeRestart[0].address, '192.168.1.31');
    assert.equal(afterRestart[0].address, '192.168.1.87');
});

test('AirPlay discovery persists a canonical hardware selector from correlated RAOP', async () => {
    let airPlayUseCache;
    let raopUseCache;
    const devices = await discoverAirPlayDevices({
        timeoutMs: 0,
        useCache: false,
        discovery: {
            async find(useCache) {
                airPlayUseCache = useCache;
                return [homePod()];
            }
        },
        raopDiscovery: {
            async find(useCache) {
                raopUseCache = useCache;
                return [{
                    address: '192.168.1.31',
                    id: 'AABBCCDDEEFF@Living-Room.local',
                    fqdn: 'AABBCCDDEEFF@Living-Room.local',
                    service: { type: '_raop._tcp.local', port: 7000 },
                    txt: {}
                }];
            }
        }
    });

    assert.equal(airPlayUseCache, false);
    assert.equal(raopUseCache, false);
    assert.equal(devices[0].host, 'raop-device:aabbccddeeff');
    assert.equal(devices[0].address, '192.168.1.31');
});

test('RAOP correlation prefers the AirPlay hardware id and never an arbitrary same-IP record', async () => {
    const devices = await discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: {
            find: async () => [homePod({
                txt: {
                    deviceid: 'AA:BB:CC:DD:EE:FF',
                    model: 'AudioAccessory6,1'
                }
            })]
        },
        raopDiscovery: {
            find: async () => [
                {
                    address: '192.168.1.31',
                    id: '112233445566@Other.local',
                    fqdn: '112233445566@Other.local',
                    service: { type: '_raop._tcp', port: 7000 }
                },
                {
                    address: '192.168.1.31',
                    id: 'AABBCCDDEEFF@Living-Room.local',
                    fqdn: 'AABBCCDDEEFF@Living-Room.local',
                    service: { type: '_raop._tcp', port: 7000 }
                }
            ]
        }
    });

    assert.equal(devices[0].host, 'raop-device:aabbccddeeff');

    const ambiguousWithoutHardwareId = await discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: { find: async () => [homePod()] },
        raopDiscovery: {
            find: async () => [
                {
                    address: '192.168.1.31',
                    id: '112233445566@Other.local',
                    fqdn: '112233445566@Other.local',
                    service: { type: '_raop._tcp', port: 7000 }
                },
                {
                    address: '192.168.1.31',
                    id: 'AABBCCDDEEFF@Living-Room.local',
                    fqdn: 'AABBCCDDEEFF@Living-Room.local',
                    service: { type: '_raop._tcp', port: 7000 }
                }
            ]
        }
    });
    assert.equal(
        ambiguousWithoutHardwareId[0].host,
        'Living-Room.local',
        'an ambiguous IP-only correlation must fall back to the AirPlay selector'
    );

    const hardwareFallback = await discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: {
            find: async () => [homePod({
                txt: {
                    deviceid: 'AA:BB:CC:DD:EE:FF',
                    model: 'AudioAccessory6,1'
                }
            })]
        },
        raopDiscovery: { find: async () => [] }
    });
    assert.equal(
        hardwareFallback[0].host,
        'raop-device:aabbccddeeff',
        'the AirPlay hardware id remains a unique selector when RAOP correlation is unavailable'
    );

    const incompatibleSameIpRecord = await discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: {
            find: async () => [homePod({
                txt: {
                    deviceid: 'AA:BB:CC:DD:EE:FF',
                    model: 'AudioAccessory6,1'
                }
            })]
        },
        raopDiscovery: {
            find: async () => [{
                address: '192.168.1.31',
                id: '112233445566@Other.local',
                fqdn: '112233445566@Other.local',
                service: { type: '_raop._tcp', port: 7000 }
            }]
        }
    });
    assert.equal(
        incompatibleSameIpRecord[0].host,
        'raop-device:aabbccddeeff',
        'a conflicting same-IP RAOP record must never override the AirPlay hardware identity'
    );
});

test('RAOP records leaked into an AirPlay response never create duplicate UI entries', async () => {
    const airPlayResult = homePod({
        txt: {
            deviceid: 'AA:BB:CC:DD:EE:FF',
            model: 'AudioAccessory6,1'
        }
    });
    const leakedRaopResult = homePod({
        id: 'AABBCCDDEEFF@Living-Room.local',
        fqdn: 'AABBCCDDEEFF@Living-Room.local',
        address: '192.168.1.99',
        familyName: null,
        service: { type: '_raop._tcp.local', port: 7000 },
        txt: { am: 'AudioAccessory6,1' }
    });

    const devices = await discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: { find: async () => [leakedRaopResult, airPlayResult] },
        raopDiscovery: { find: async () => [leakedRaopResult] }
    });

    assert.deepEqual(devices, [{
        name: 'Living Room',
        host: 'raop-device:aabbccddeeff',
        address: '192.168.1.31',
        model: 'AudioAccessory6,1'
    }]);
    assert.equal(devices.some((device) => device.name.includes('@')), false);

    const rawAirPlayOnly = await discoverRaw({
        timeoutMs: 0,
        discovery: { find: async () => [leakedRaopResult, airPlayResult] }
    });
    assert.deepEqual(rawAirPlayOnly, [airPlayResult]);
});

test('duplicate AirPlay advertisements merge by hardware identity without merging distinct receivers', async () => {
    const duplicateHardwareId = {
        deviceid: 'AA:BB:CC:DD:EE:FF',
        model: 'AudioAccessory6,1'
    };
    const devices = await discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: {
            find: async () => [
                homePod({ txt: duplicateHardwareId }),
                homePod({
                    id: 'Living-Room-alias.local',
                    fqdn: 'Living-Room-alias.local',
                    address: '192.168.1.87',
                    txt: duplicateHardwareId
                }),
                homePod({
                    id: 'Office.local',
                    fqdn: 'Office.local',
                    familyName: 'Living Room',
                    txt: {
                        deviceid: '11:22:33:44:55:66',
                        model: 'AudioAccessory6,1'
                    }
                })
            ]
        }
    });

    assert.equal(devices.length, 2);
    assert.deepEqual(
        devices.map((device) => device.host).sort(),
        ['raop-device:112233445566', 'raop-device:aabbccddeeff']
    );
});

test('a late stereo advertisement merges groups independently of mDNS packet order', async () => {
    const standaloneLeft = homePod({
        id: 'Studio-Left.local',
        fqdn: 'Studio-Left.local',
        address: '192.0.2.60',
        familyName: 'Studio Left',
        modelName: 'AudioAccessory1,1',
        txt: {
            deviceid: 'AA:BB:CC:DD:EE:FF',
            model: 'AudioAccessory1,1'
        }
    });
    const stereoRight = homePod({
        id: 'Studio-Right.local',
        fqdn: 'Studio-Right.local',
        address: '192.0.2.61',
        familyName: 'Studio Right',
        modelName: 'AudioAccessory1,1',
        txt: {
            deviceid: '11:22:33:44:55:66',
            gpn: 'Studio',
            igl: '0',
            model: 'AudioAccessory1,1',
            pgmid: '2',
            tsid: 'PAIR-ID'
        }
    });
    const stereoLeft = homePod({
        id: 'Studio-Left.local',
        fqdn: 'Studio-Left.local',
        address: '192.0.2.60',
        familyName: 'Studio Left',
        modelName: 'AudioAccessory1,1',
        txt: {
            deviceid: 'AA:BB:CC:DD:EE:FF',
            gpn: 'Studio',
            igl: '0',
            model: 'AudioAccessory1,1',
            pgmid: '1',
            tsid: 'PAIR-ID'
        }
    });

    const discoverInOrder = async (results) => discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: { find: async () => results }
    });
    const discoveredOrders = await Promise.all([
        [standaloneLeft, stereoLeft, stereoRight],
        [standaloneLeft, stereoRight, stereoLeft],
        [stereoLeft, standaloneLeft, stereoRight],
        [stereoLeft, stereoRight, standaloneLeft],
        [stereoRight, standaloneLeft, stereoLeft],
        [stereoRight, stereoLeft, standaloneLeft]
    ].map(discoverInOrder));
    const canonicalGroup = discoveredOrders[0];

    discoveredOrders.forEach((devices) => assert.deepEqual(devices, canonicalGroup));
    assert.equal(canonicalGroup.length, 1);
    assert.deepEqual(canonicalGroup[0], {
        name: 'Studio',
        host: 'raop-device:aabbccddeeff',
        address: '192.0.2.60',
        model: 'AudioAccessory1,1',
        groupId: 'PAIR-ID',
        members: ['192.0.2.60', '192.0.2.61'],
        memberHosts: ['raop-device:aabbccddeeff', 'raop-device:112233445566']
    });
});

test('discoverAirPlayDevices creates AirPlay discovery through injected module', async () => {
    let airplayCalls = 0;
    let findUseCache;
    const commonModule = {
        Discovery: {
            airplay() {
                airplayCalls += 1;
                return {
                    async find(useCache) {
                        findUseCache = useCache;
                        return [homePod()];
                    }
                };
            }
        }
    };

    const devices = await discoverAirPlayDevices({
        commonModule,
        timeoutMs: 0,
        useCache: false
    });

    assert.equal(airplayCalls, 1);
    assert.equal(findUseCache, false);
    assert.equal(devices.length, 1);
});

test('stereo-pair members collapse to one canonical group leader', async () => {
    const raw = [
        homePod({
            id: 'Studio-Right.local',
            address: '192.0.2.60',
            familyName: 'Studio Right',
            modelName: 'AudioAccessory1,1',
            txt: { model: 'AudioAccessory1,1', tsid: 'PAIR-ID', gpn: 'Studio', pgmid: '2', igl: '0' }
        }),
        homePod({
            id: 'Studio-Left.local',
            address: '192.0.2.61',
            familyName: 'Studio Left',
            modelName: 'AudioAccessory1,1',
            txt: { model: 'AudioAccessory1,1', tsid: 'PAIR-ID', gpn: 'Studio', pgmid: '1', igl: '0' }
        })
    ];

    const devices = await discoverAirPlayDevices({
        timeoutMs: 0,
        discovery: { find: async () => raw }
    });

    assert.deepEqual(devices, [{
        name: 'Studio',
        host: 'Studio-Left.local',
        address: '192.0.2.61',
        model: 'AudioAccessory1,1',
        groupId: 'PAIR-ID',
        members: ['192.0.2.61', '192.0.2.60'],
        memberHosts: ['Studio-Left.local', 'Studio-Right.local']
    }]);
});

test('discoverAirPlayDevices propagates discovery failures', async () => {
    await assert.rejects(
        discoverAirPlayDevices({
            timeoutMs: 0,
            discovery: {
                find: async () => {
                    throw new Error('mDNS socket unavailable');
                }
            }
        }),
        /mDNS socket unavailable/
    );
});

test('HomePod identification and display-name fallbacks handle vendor TXT fields', () => {
    assert.equal(isHomePod(homePod()), true);
    assert.equal(isHomePod(homePod({ modelName: '', txt: { am: 'AudioAccessory5,1' } })), true);
    assert.equal(isHomePod(homePod({ modelName: 'AppleTV14,1', txt: {} })), false);

    assert.equal(displayName(homePod({ familyName: 'Office', txt: { name: 'Ignored' } })), 'Office');
    assert.equal(displayName(homePod({ familyName: null, txt: { name: 'Kitchen' } })), 'Kitchen');
    assert.equal(
        displayName(homePod({ familyName: null, txt: {}, id: 'Office-Pod.local' })),
        'Office Pod'
    );
    assert.equal(
        displayName(homePod({
            familyName: null,
            txt: {},
            id: 'AABBCCDDEEFF@Living-Room.local'
        })),
        'Living Room'
    );
    assert.equal(displayName(homePod({ familyName: 'Office@Floor' })), 'Office@Floor');
});
