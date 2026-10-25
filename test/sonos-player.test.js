'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const dgram = require('dgram');

const { parseXml } = require('../ttsultimate/lib/xml-to-object');
const { Sonos, AsyncDeviceDiscovery, generateMetadata } = require('../ttsultimate/lib/sonos-player');

// Expected values below were produced by xml2js with { mergeAttrs: true, explicitArray: false },
// the parser used by the former "sonos" package.
test('parseXml matches the xml2js shape', () => {
    assert.deepEqual(
        parseXml('<?xml version="1.0"?><root>\n  <a x="1">text</a>\n  <a>two</a>\n  <b><![CDATA[<raw> & stuff]]></b>\n  <!-- c -->\n  <c y=\'q\'>  padded  </c><e></e><f/><s>   </s>\n</root>'),
        { root: { a: [{ _: 'text', x: '1' }, 'two'], b: '<raw> & stuff', c: { _: '  padded  ', y: 'q' }, e: '', f: '', s: '   ' } }
    );
    assert.deepEqual(
        parseXml('<DIDL-Lite xmlns="d"><item id="-1"><res duration="0:03:10">x-sonos-http:a.mp3?sid=2&amp;sn=1</res><dc:title>Song &#233; &#x263A;</dc:title></item></DIDL-Lite>'),
        { 'DIDL-Lite': { xmlns: 'd', item: { id: '-1', res: { _: 'x-sonos-http:a.mp3?sid=2&sn=1', duration: '0:03:10' }, 'dc:title': 'Song é ☺' } } }
    );
    assert.equal(parseXml('   '), null);
    for (const bad of ['<a><b></a>', '<a>', 'text', '<a/><b/>']) {
        assert.throws(() => parseXml(bad), undefined, bad);
    }
});

test('generateMetadata keeps plain URLs and builds TuneIn / Spotify metadata', () => {
    assert.deepEqual(generateMetadata('http://192.168.1.5:1980/tts/tts.mp3?f=a.mp3'), { uri: 'http://192.168.1.5:1980/tts/tts.mp3?f=a.mp3', metadata: '' });
    const radio = generateMetadata('radio:s1234');
    assert.equal(radio.uri, 'x-sonosapi-stream:s1234?sid=254&flags=8224&sn=0');
    assert.match(radio.metadata, /<item id="F00092020s1234" parentID="L" restricted="true"><dc:title>TuneIn Radio<\/dc:title>/);
    const spotify = generateMetadata('spotify:track:4LI1ykYGFCcXPWkrpcU7hn');
    assert.equal(spotify.uri, 'x-sonos-spotify:spotify%3atrack%3a4LI1ykYGFCcXPWkrpcU7hn');
    assert.match(spotify.metadata, /SA_RINCON3079_X_#Svc3079-0-Token/);
});

// Fake Sonos: answers SOAP actions from a table and records every request.
function fakeSonos(t, answers) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const action = /#(\w+)"$/.exec(req.headers.soapaction)[1];
            const service = /service:(\w+):1/.exec(req.headers.soapaction)[1];
            requests.push({ path: req.url, action, contentType: req.headers['content-type'], body });
            const answer = answers[action];
            if (answer && answer.status) {
                res.writeHead(answer.status);
                return res.end(answer.body);
            }
            let inner = '';
            for (const [key, value] of Object.entries(answer || {})) inner += `<${key}>${value}</${key}>`;
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${inner}</u:${action}Response></s:Body></s:Envelope>`);
        });
    });
    t.after(() => server.close());
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ sonos: new Sonos('127.0.0.1', server.address().port), port: server.address().port, requests })));
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('sends the same SOAP requests as the sonos package', async (t) => {
    const { sonos, requests } = await fakeSonos(t, {});
    await sonos.setVolume(30);
    await sonos.setMuted(false);
    await sonos.setAVTransportURI('http://192.168.1.5:1980/tts/tts.mp3?f=a&b=<1>');
    await sonos.seek(3725);

    assert.deepEqual(requests.map((r) => r.path + ' ' + r.action), [
        '/MediaRenderer/RenderingControl/Control SetVolume',
        '/MediaRenderer/RenderingControl/Control SetMute',
        '/MediaRenderer/AVTransport/Control SetAVTransportURI',
        '/MediaRenderer/AVTransport/Control Play',
        '/MediaRenderer/AVTransport/Control Seek'
    ]);
    assert.equal(requests[0].contentType, 'text/xml; charset=utf8');
    assert.equal(requests[0].body,
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
        '<u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>30</DesiredVolume></u:SetVolume>' +
        '</s:Body></s:Envelope>');
    assert.match(requests[1].body, /<DesiredMute>0<\/DesiredMute>/);
    assert.match(requests[2].body, /<CurrentURI>http:\/\/192.168.1.5:1980\/tts\/tts.mp3\?f=a&amp;b=&lt;1&gt;<\/CurrentURI><CurrentURIMetaData><\/CurrentURIMetaData>/);
    assert.match(requests[3].body, /<InstanceID>0<\/InstanceID><Speed>1<\/Speed>/);
    assert.match(requests[4].body, /<Unit>REL_TIME<\/Unit><Target>01:02:05<\/Target>/);
});

test('reads state, volume, mute, name and current track', async (t) => {
    const didl = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="-1" parentID="S:abc"><upnp:albumArtURI>/getaa?u=x</upnp:albumArtURI><dc:title>Song</dc:title><dc:creator>Artist</dc:creator><upnp:album>Album</upnp:album></item></DIDL-Lite>';
    const { sonos, port } = await fakeSonos(t, {
        GetTransportInfo: { CurrentTransportState: 'PAUSED_PLAYBACK' },
        GetVolume: { CurrentVolume: '25' },
        GetMute: { CurrentMute: '1' },
        GetZoneAttributes: { CurrentZoneName: 'Kitchen &amp; Co' },
        GetPositionInfo: { Track: '3', TrackDuration: '0:03:10', TrackMetaData: xmlEscape(didl), TrackURI: 'x-sonos-spotify:x?sid=9&amp;sn=1', RelTime: '0:01:05' }
    });
    assert.equal(await sonos.getCurrentState(), 'paused');
    assert.equal(await sonos.getVolume(), 25);
    assert.equal(await sonos.getMuted(), true);
    assert.equal(await sonos.getName(), 'Kitchen & Co');
    assert.deepEqual(await sonos.currentTrack(), {
        id: null, parentID: 'abc', title: 'Song', artist: 'Artist', album: 'Album', albumArtist: null,
        albumArtURI: '/getaa?u=x', position: 65, duration: 190, albumArtURL: `http://127.0.0.1:${port}/getaa?u=x`,
        uri: 'x-sonos-spotify:x?sid=9&sn=1', queuePosition: 3
    });
});

test('selectQueue builds the queue uri from the MAC address', async (t) => {
    const { sonos, port, requests } = await fakeSonos(t, { GetZoneInfo: { MACAddress: '00:0E:58:AA:BB:CC' } });
    await sonos.selectQueue();
    const setUri = requests.find((r) => r.action === 'SetAVTransportURI');
    assert.match(setUri.body, new RegExp(`<CurrentURI>x-rincon-queue:RINCON_000E58AABBCC0${port}#0</CurrentURI>`));
});

test('groups: getAllGroups, joinGroup and leaveGroup', async (t) => {
    const zgs = '<ZoneGroupState><ZoneGroups>' +
        '<ZoneGroup Coordinator="RINCON_1" ID="RINCON_1:1"><ZoneGroupMember UUID="RINCON_1" Location="http://192.168.1.10:1400/xml/device_description.xml" ZoneName="Kitchen"/><ZoneGroupMember UUID="RINCON_2" Location="http://192.168.1.11:1400/xml/device_description.xml" ZoneName="Living Room"/></ZoneGroup>' +
        '<ZoneGroup Coordinator="RINCON_3" ID="RINCON_3:2"><ZoneGroupMember UUID="RINCON_3" Location="http://192.168.1.12:1400/xml/device_description.xml" ZoneName="Bath"/></ZoneGroup>' +
        '</ZoneGroups></ZoneGroupState>';
    const { sonos, requests } = await fakeSonos(t, { GetZoneGroupState: { ZoneGroupState: xmlEscape(zgs) } });
    const groups = await sonos.getAllGroups();
    assert.deepEqual(groups.map((g) => [g.Name, g.host, g.port, g.ZoneGroupMember.length]), [['Kitchen + 1', '192.168.1.10', 1400, 2], ['Bath', '192.168.1.12', 1400, 1]]);
    assert.equal(groups[1].CoordinatorDevice().host, '192.168.1.12');

    assert.equal(await sonos.joinGroup('living room'), true);
    const join = requests.find((r) => r.action === 'SetAVTransportURI');
    assert.match(join.body, /<CurrentURI>x-rincon:RINCON_1<\/CurrentURI>/);
    assert.equal(requests.some((r) => r.action === 'Play'), false, 'joining a group must not start playback');
    assert.match((await sonos.joinGroup('Garage')).message, /Garage isn't found/);
    assert.equal(await sonos.leaveGroup(), true);
    assert.equal(requests[requests.length - 1].action, 'BecomeCoordinatorOfStandaloneGroup');
});

test('errors keep the sonos package format', async (t) => {
    const fault = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring></s:Fault></s:Body></s:Envelope>';
    const { sonos } = await fakeSonos(t, {
        Seek: { status: 500, body: fault },
        Stop: { status: 404, body: 'nope' },
        GetTransportInfo: { status: 200, body: fault }
    });
    await assert.rejects(sonos.selectTrack(2), { message: 'upnp: statusCode 500 & upnpErrorCode ' + fault });
    await assert.rejects(sonos.stop(), { message: 'upnp: Request failed with status code 404///nope' });
    await assert.rejects(sonos.getCurrentState(), (err) => err.faultstring === 'UPnPError');
    await assert.rejects(new Sonos('127.0.0.1', 1).getCurrentState(), /ECONNREFUSED/);
});

test('discovery resolves with the first device answering the SSDP search', async (t) => {
    const responder = dgram.createSocket('udp4');
    t.after(() => responder.close());
    responder.on('message', (msg, rinfo) => {
        if (!/ST: urn:schemas-upnp-org:device:ZonePlayer:1/.test(msg.toString())) return;
        const reply = Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:1400/xml/device_description.xml\r\nSERVER: Linux UPnP/1.0 Sonos/80.1-55014 (ZPS27)\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');
        responder.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise((resolve) => responder.bind(0, '127.0.0.1', resolve));
    const device = await new AsyncDeviceDiscovery().discover({ timeout: 3000, addresses: ['127.0.0.1'], searchPort: responder.address().port });
    assert.ok(device instanceof Sonos);
    assert.equal(device.host, '127.0.0.1');
    assert.equal(device.port, 1400);
});

test('discovery rejects when no device answers', async () => {
    await assert.rejects(new AsyncDeviceDiscovery().discover({ timeout: 200, addresses: ['127.0.0.1'], searchPort: 9 }), /No device found/);
});
