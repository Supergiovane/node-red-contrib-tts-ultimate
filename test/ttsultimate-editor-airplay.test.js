'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const editorPath = path.join(__dirname, '..', 'ttsultimate', 'ttsultimate.html');

test('AirPlay editor restores saved master/additional selections visibly', () => {
    const html = fs.readFileSync(editorPath, 'utf8');
    const editorScript = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);

    assert.ok(editorScript, 'the Node-RED editor script must exist');
    assert.doesNotThrow(() => new Function(editorScript[1]));

    const helpersStart = editorScript[1].indexOf('function discoveredPlayerAliases');
    const helpersEnd = editorScript[1].indexOf('// Discovery for the MAIN player address field');
    assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'discovery selection helpers must exist');
    const helpers = new Function(
        editorScript[1].slice(helpersStart, helpersEnd) +
        '; return { canonicalDiscoveredHost, compareDiscoveredPlayers, discoveredPlayerAliases, discoveredPlayerHardwareId, legacyAirPlayAddressMatch };'
    )();
    const discoveredStereoPair = {
        address: '192.168.1.87',
        host: 'raop-device:aabbccddeeff',
        memberHosts: [
            'raop-device:aabbccddeeff',
            'raop-device:112233445566'
        ],
        members: ['192.168.1.87', '192.168.1.88']
    };

    assert.deepEqual(helpers.discoveredPlayerAliases(discoveredStereoPair), [
        'raop-device:aabbccddeeff',
        'raop-device:112233445566'
    ]);
    assert.equal(
        helpers.canonicalDiscoveredHost('AABBCCDDEEFF@LIVING-ROOM.LOCAL', discoveredStereoPair),
        discoveredStereoPair.host,
        'a stable selector match must be case-insensitive'
    );
    assert.equal(
        helpers.canonicalDiscoveredHost('112233445566@living-room.local', discoveredStereoPair),
        discoveredStereoPair.host,
        'a stereo member selector must canonicalize to the group leader'
    );
    assert.equal(
        helpers.discoveredPlayerHardwareId('AA:BB:CC:DD:EE:FF@Living-Room.local'),
        'aabbccddeeff',
        'old RAOP service identities must normalize to their hardware id'
    );
    assert.deepEqual(
        [{ name: 'HomePod 10' }, { name: 'homepod 2' }]
            .sort(helpers.compareDiscoveredPlayers)
            .map((device) => device.name),
        ['homepod 2', 'HomePod 10'],
        'master and additional lists must use the same case-insensitive numeric order'
    );
    assert.equal(
        helpers.canonicalDiscoveredHost('192.168.1.87', discoveredStereoPair),
        null,
        'a legacy IP must not be silently migrated to whichever device owns that lease now'
    );
    assert.equal(
        helpers.legacyAirPlayAddressMatch('192.168.1.87', discoveredStereoPair, 'airplay'),
        '192.168.1.87',
        'a matching legacy IP must share the discovered row without being migrated automatically'
    );
    assert.equal(
        helpers.legacyAirPlayAddressMatch('192.168.1.87', discoveredStereoPair, 'dlna'),
        null,
        'legacy address reconciliation is specific to AirPlay'
    );

    assert.match(
        html,
        /var savedHost = String\(\$\("#node-input-playeripaddress"\)\.val\(\) \|\| node\.playeripaddress \|\| ""\)\.trim\(\)/,
        'main discovery must read the persisted player address'
    );
    assert.match(
        html,
        /Saved device \(" \+ savedHost \+ "\) - not discovered/,
        'an offline saved master must remain visible'
    );
    assert.match(
        html,
        /-- select a discovered device --/,
        'an empty additional row must show a placeholder instead of a blank select'
    );
    assert.match(
        html,
        /if \(!rowRulePlayerHost\) return;/,
        'placeholder rows must not be persisted as null hosts'
    );
    assert.match(
        html,
        /requestGeneration !== playerDiscoveryGeneration/,
        'a stale discovery response must not replace the current player type'
    );
    assert.match(
        html,
        /Array\.isArray\(dev\.memberHosts\)/,
        'a saved stereo-pair identity must migrate to its canonical discovery option'
    );
    assert.match(
        html,
        /option\.attr\("data-canonical-host", dev\.host\)/,
        'explicitly reselecting a legacy master must persist the stable selector'
    );
    assert.match(
        html,
        /option\.attr\("data-canonical-host", oGroup\.host\)/,
        'explicitly reselecting a legacy additional player must persist the stable selector'
    );
    assert.match(
        html,
        /savedPlayerHosts\.has\(rowRulePlayerHost\.toLowerCase\(\)\)/,
        'the canonical master must not be saved again as an additional player'
    );
});


test('both HomePod transports share discovery and additional-player controls', () => {
    const html = fs.readFileSync(editorPath, 'utf8');
    assert.match(html, /<option value="airplay">HomePod \(AirPlay 2, experimental\)<\/option>/);
    assert.match(html, /<option value="airplayraop">HomePod — RAOP \(legacy\)<\/option>/);
    assert.doesNotMatch(html, /<option value="airplay2">/, 'the pre-release value is only accepted, not offered');
    const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
    let selected;
    const start = script.indexOf('function isAirPlayPlayer');
    const end = script.indexOf('function discoveredPlayerAliases');
    const helpers = new Function('$', script.slice(start, end) +
        '; return { currentPlayerDiscoveryUrl, supportsAdditionalPlayers };')(
        () => ({ val: () => selected })
    );
    for (selected of ['airplay', 'airplay2', 'airplayraop']) {
        assert.equal(helpers.currentPlayerDiscoveryUrl(), 'ttsultimateDiscoverAirPlay');
        assert.equal(helpers.supportsAdditionalPlayers(selected), true);
    }
    const legacyStart = script.indexOf('function discoveredPlayerAliases');
    const legacyEnd = script.indexOf('// Discovery for the MAIN player address field');
    const legacyMatch = new Function(script.slice(legacyStart, legacyEnd) +
        '; return legacyAirPlayAddressMatch;')();
    assert.equal(legacyMatch('192.168.1.50', { address: '192.168.1.50' }, 'airplay2'), '192.168.1.50');
    assert.equal(legacyMatch('192.168.1.50', { address: '192.168.1.50' }, 'airplayraop'), '192.168.1.50');
});
