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
        /Array\.isArray\(dev\.members\)/,
        'a saved stereo-pair member must migrate to its canonical discovery option'
    );
    assert.match(
        html,
        /savedPlayerHosts\.has\(rowRulePlayerHost\.toLowerCase\(\)\)/,
        'the canonical master must not be saved again as an additional player'
    );
});
