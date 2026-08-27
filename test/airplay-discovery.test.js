'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    discoverAirPlayDevices,
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
        txt: {
            features: '0x4A7FCA00,0xBC354BD0',
            model: 'AudioAccessory6,1'
        },
        // The vendor SDK exposes this as bigint.  The admin endpoint must never
        // leak it into res.json(), where JSON.stringify would throw.
        features: 1n << 46n
    }, overrides);
}

test('discoverAirPlayDevices returns JSON-safe HomePods using the IP as host', async () => {
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
            name: 'Living Room',
            host: '192.168.1.31',
            address: '192.168.1.31',
            model: 'AudioAccessory6,1'
        },
        {
            name: 'Kitchen Pod',
            host: '192.168.1.32',
            address: '192.168.1.32',
            model: 'AudioAccessory5,1'
        }
    ]);
    assert.doesNotThrow(() => JSON.stringify(devices));
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
        host: '192.0.2.61',
        address: '192.0.2.61',
        model: 'AudioAccessory1,1',
        groupId: 'PAIR-ID',
        members: ['192.0.2.60', '192.0.2.61']
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
});
