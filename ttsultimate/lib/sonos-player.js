// Minimal native Sonos client: the subset of the "sonos" package (node-sonos, MIT) used by TTS-Ultimate.
// The methods keep the same names, arguments, SOAP requests and return values as sonos 1.14.x,
// so the node logic did not change. It uses only built-in modules (http, dgram, events) and
// replaces the "sonos" dependency together with its axios / ip / xml2js sub-dependencies.
// Not ported: event subscriptions (TTS-Ultimate does not use them) and the rest of the API.
const http = require("http");
const dgram = require("dgram");
const { EventEmitter } = require("events");
const { parseXml } = require("./xml-to-object");

const TRANSPORT_ENDPOINT = "/MediaRenderer/AVTransport/Control";
const RENDERING_ENDPOINT = "/MediaRenderer/RenderingControl/Control";
const DEVICE_ENDPOINT = "/DeviceProperties/Control";
const TOPOLOGY_ENDPOINT = "/ZoneGroupTopology/Control";
const SPOTIFY_REGION_US = "3079";

// ######################################################
// Helpers (ported from sonos/lib/helpers.js)

function encodeXml(input) {
    return String(input).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function createSoapEnvelope(body) {
    return '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
        "<s:Body>" + body + "</s:Body>" +
        "</s:Envelope>";
}

function getUpnpClass(parentID) {
    switch (parentID) {
        case "A:ALBUMS": return "object.item.audioItem.musicAlbum";
        case "A:TRACKS": return "object.item.audioItem.musicTrack";
        case "A:ALBUMARTIST": return "object.item.audioItem.musicArtist";
        case "A:GENRE": return "object.container.genre.musicGenre";
        case "A:COMPOSER": return "object.container.person.composer";
        default: return "";
    }
}

function generateLocalMetadata(uri, artUri = "") {
    let title = "";
    const match = /.*\/(.*)$/g.exec(uri.replace(/\.[a-zA-Z0-9]{3}$/, ""));
    if (match) title = match[1];
    const meta = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="##ITEMID##" parentID="##PARENTID##" restricted="true"><dc:title>##RESOURCETITLE##</dc:title><upnp:class>##UPNPCLASS##</upnp:class><upnp:albumArtURI>##ARTURI##</upnp:albumArtURI><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">##REGION##</desc></item></DIDL-Lite>';
    if (uri.startsWith("x-file-cifs")) {
        return {
            uri,
            metadata: meta.replace("##ITEMID##", uri.replace("x-file-cifs", "S").replace(/\s/g, "%20"))
                .replace("##RESOURCETITLE##", title.replace("%20", " "))
                .replace("##UPNPCLASS##", getUpnpClass("A:TRACKS"))
                .replace("##PARENTID##", "A:TRACKS")
                .replace("##ARTURI##", artUri.replace(/\s/g, "%20"))
                .replace("##REGION##", "RINCON_AssociatedZPUDN")
        };
    }
    if (uri.startsWith("x-rincon-playlist")) {
        const parentMatch = /.*#(.*)\/.*/g.exec(uri);
        const parentID = parentMatch[1];
        return {
            uri,
            metadata: meta.replace("##ITEMID##", `${parentID}/${title.replace(/\s/g, "%20")}`)
                .replace("##RESOURCETITLE##", title.replace("%20", " "))
                .replace("##UPNPCLASS##", getUpnpClass(parentID))
                .replace("##PARENTID##", parentID)
                .replace("##ARTURI##", artUri.replace(/\s/g, "%20"))
                .replace("##REGION##", "RINCON_AssociatedZPUDN")
        };
    }
    return { uri, metadata: "" };
}

// Creates { uri, metadata } from a playback uri (plain URLs, TuneIn radio, Spotify, Amazon, SoundCloud).
function generateMetadata(uri, title = "", region = SPOTIFY_REGION_US) {
    const parts = uri.split(":");
    if (!((parts.length === 2 && (parts[0] === "radio" || parts[0] === "x-sonosapi-stream" || parts[0] === "x-rincon-cpcontainer")) || (parts.length >= 3 && parts[0] === "spotify"))) {
        return generateLocalMetadata(uri);
    }
    let meta = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="##SPOTIFYURI##" ##PARENTID##restricted="true"><dc:title>##RESOURCETITLE##</dc:title><upnp:class>##SPOTIFYTYPE##</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">##REGION##</desc></item></DIDL-Lite>';

    if (parts[0] === "radio" || parts[0] === "x-sonosapi-stream") {
        const radioTitle = title || "TuneIn Radio";
        if (parts[0] === "radio") {
            return {
                uri: "x-sonosapi-stream:" + parts[1] + "?sid=254&flags=8224&sn=0",
                metadata: meta.replace("##SPOTIFYURI##", "F00092020" + parts[1])
                    .replace("##RESOURCETITLE##", encodeXml(radioTitle))
                    .replace("##SPOTIFYTYPE##", "object.item.audioItem.audioBroadcast")
                    .replace("##PARENTID##", 'parentID="L" ')
                    .replace("##REGION##", "SA_RINCON65031_")
            };
        }
        const itemId = parts[1].split("?")[0];
        return {
            uri,
            metadata: meta.replace("##SPOTIFYURI##", "F00092020" + itemId)
                .replace("##RESOURCETITLE##", radioTitle)
                .replace("##SPOTIFYTYPE##", "object.item.audioItem.audioBroadcast")
                .replace("##PARENTID##", 'parentID="R:0/0" ')
                .replace("##REGION##", "SA_RINCON65031_")
        };
    }
    meta = meta.replace("##REGION##", "SA_RINCON" + region + "_X_#Svc" + region + "-0-Token");
    const spotifyUri = uri.replace(/:/g, "%3a");

    if (uri.startsWith("spotify:track:")) {
        return {
            uri: "x-sonos-spotify:" + spotifyUri,
            metadata: meta.replace("##SPOTIFYURI##", "00032020" + spotifyUri).replace("##RESOURCETITLE##", "")
                .replace("##SPOTIFYTYPE##", "object.item.audioItem.musicTrack").replace("##PARENTID##", "")
        };
    } else if (uri.startsWith("spotify:album:")) {
        return {
            uri: "x-rincon-cpcontainer:0004206c" + spotifyUri,
            metadata: meta.replace("##SPOTIFYURI##", "0004206c" + spotifyUri).replace("##RESOURCETITLE##", "")
                .replace("##SPOTIFYTYPE##", "object.container.album.musicAlbum").replace("##PARENTID##", "")
        };
    } else if (uri.startsWith("spotify:artistTopTracks:")) {
        return {
            uri: "x-rincon-cpcontainer:000e206c" + spotifyUri,
            metadata: meta.replace("##SPOTIFYURI##", "000e206c" + spotifyUri).replace("##RESOURCETITLE##", "")
                .replace("##SPOTIFYTYPE##", "object.container.playlistContainer").replace("##PARENTID##", "")
        };
    } else if (uri.startsWith("spotify:playlist:")) {
        return {
            uri: "x-rincon-cpcontainer:1006206c" + spotifyUri,
            metadata: meta.replace("##SPOTIFYURI##", "1006206c" + spotifyUri).replace("##RESOURCETITLE##", "")
                .replace("##SPOTIFYTYPE##", "object.container.album.playlistContainer").replace("##PARENTID##", "")
        };
    } else if (uri.startsWith("spotify:user:")) {
        return {
            uri: "x-rincon-cpcontainer:10062a6c" + spotifyUri + "?sid=9&flags=10860&sn=7",
            metadata: meta.replace("##SPOTIFYURI##", "10062a6c" + spotifyUri).replace("##RESOURCETITLE##", "User playlist")
                .replace("##SPOTIFYTYPE##", "object.container.playlistContainer").replace("##PARENTID##", 'parentID="10082664playlists" ')
        };
    } else if (uri.startsWith("spotify:artistRadio:")) {
        const spotifyTitle = title || "Artist Radio";
        const parentId = spotifyUri.replace("artistRadio", "artist");
        return {
            uri: "x-sonosapi-radio:" + spotifyUri + "?sid=12&flags=8300&sn=5",
            metadata: meta.replace("##SPOTIFYURI##", "100c206c" + spotifyUri).replace("##RESOURCETITLE##", spotifyTitle)
                .replace("##SPOTIFYTYPE##", "object.item.audioItem.audioBroadcast.#artistRadio")
                .replace("##PARENTID##", 'parentID="10052064' + parentId + '" ')
        };
    } else if (uri.startsWith("x-rincon-cpcontainer:1006206ccatalog")) { // Amazon prime container
        const [id] = uri.match(/^x-rincon-cpcontainer:(.*)\?.*/).splice(1);
        return {
            uri: String(uri).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\""),
            metadata: meta.replace("##SPOTIFYURI##", id).replace("##RESOURCETITLE##", title)
                .replace("##SPOTIFYTYPE##", "object.container.playlistContainer").replace("##PARENTID##", "")
        };
    } else if (uri.startsWith("x-rincon-cpcontainer:100d206cuser-fav")) { // Sound Cloud likes
        const id = uri.replace("x-rincon-cpcontainer:", "");
        return {
            uri,
            metadata: meta.replace("##SPOTIFYURI##", id).replace("##RESOURCETITLE##", title || "Sound Cloud Likes")
                .replace("##SPOTIFYTYPE##", "object.container.albumList").replace("##PARENTID##", "")
                .replace(`SA_RINCON${region}_X_#Svc${region}-0-Token`, "SA_RINCON40967_X_#Svc40967-0-Token")
        };
    } else if (uri.startsWith("x-rincon-cpcontainer:1006206cplaylist")) { // Sound Cloud playlists
        const [id] = uri.replace("x-rincon-cpcontainer:", "").split("?");
        return {
            uri,
            metadata: meta.replace("##SPOTIFYURI##", id).replace("##RESOURCETITLE##", title || "Sound Cloud Playlist")
                .replace("##SPOTIFYTYPE##", "object.container.playlistContainer").replace("##PARENTID##", "")
                .replace(`SA_RINCON${region}_X_#Svc${region}-0-Token`, "SA_RINCON40967_X_#Svc40967-0-Token")
        };
    }
    return { uri, metadata: "" };
}

function dropIDNamespace(value) {
    if (!value) return null;
    const ret = value.split(":", 2)[1];
    if (!ret || ret.length === 0) return null;
    return ret;
}

function parseDIDL(didl) {
    if (!didl || !didl["DIDL-Lite"]) return {};
    const item = didl["DIDL-Lite"].item;
    let albumArtURI = item["upnp:albumArtURI"] || null;
    if (albumArtURI && Array.isArray(albumArtURI)) albumArtURI = albumArtURI.length > 0 ? albumArtURI[0] : null;
    return {
        id: dropIDNamespace(item.id),
        parentID: dropIDNamespace(item.parentID),
        title: item["r:streamContent"] || item["dc:title"] || null,
        artist: item["dc:creator"] || null,
        album: item["upnp:album"] || null,
        albumArtist: item["r:albumArtist"] || null,
        albumArtURI
    };
}

function timeToSeconds(time) {
    const timeSplit = time.split(":");
    return (parseInt(timeSplit[0], 10) * 60 * 60) + (parseInt(timeSplit[1], 10) * 60) + parseInt(timeSplit[2], 10);
}

const playbackStates = { STOPPED: "stopped", PLAYING: "playing", PAUSED_PLAYBACK: "paused", TRANSITIONING: "transitioning", NO_MEDIA_PRESENT: "no_media" };
function translateState(state) {
    return playbackStates[state] || state;
}

// Like the former axios call: resolves with the body on 2xx, rejects on other status codes or network errors.
function httpPost(host, port, path, headers, body) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(body, "utf8");
        const req = http.request({ host, port, path, method: "POST", headers: Object.assign({}, headers, { "Content-Length": payload.length }) }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.end(payload);
    });
}

// ######################################################
// Sonos device

class Sonos {
    constructor(host, port, options) {
        this.host = host;
        this.port = port || 1400;
        this.options = options || {};
        this.options.spotify = this.options.spotify || {};
        this.options.spotify.region = this.options.spotify.region || SPOTIFY_REGION_US;
    }

    // Calls a UPnP action and resolves with the response fields (ported from sonos/lib/services/Service.js).
    async _request(serviceName, controlURL, action, variables) {
        const messageAction = `"urn:schemas-upnp-org:service:${serviceName}:1#${action}"`;
        let messageBody = `<u:${action} xmlns:u="urn:schemas-upnp-org:service:${serviceName}:1">`;
        if (variables) {
            Object.keys(variables).forEach(key => {
                messageBody += `<${key}>${variables[key]}</${key}>`;
            });
        }
        messageBody += `</u:${action}>`;
        const responseTag = `u:${action}Response`;
        const response = await httpPost(this.host, this.port, controlURL, {
            SOAPAction: messageAction,
            "Content-type": "text/xml; charset=utf8"
        }, createSoapEnvelope(messageBody));
        if (response.statusCode === 500) throw new Error("upnp: statusCode 500 & upnpErrorCode " + response.body);
        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error("upnp: Request failed with status code " + response.statusCode + "///" + response.body);
        }
        const result = parseXml(response.body);
        if (!result || !result["s:Envelope"]) throw new Error("Invalid response for " + action + ": " + result);
        if (typeof result["s:Envelope"]["s:Body"]["s:Fault"] !== "undefined") throw result["s:Envelope"]["s:Body"]["s:Fault"];
        const output = result["s:Envelope"]["s:Body"][responseTag];
        delete output["xmlns:u"];
        return output;
    }

    _avTransport(action, variables) { return this._request("AVTransport", TRANSPORT_ENDPOINT, action, variables); }
    _renderingControl(action, variables) { return this._request("RenderingControl", RENDERING_ENDPOINT, action, variables); }
    _deviceProperties(action, variables) { return this._request("DeviceProperties", DEVICE_ENDPOINT, action, variables); }
    _zoneGroupTopology(action, variables) { return this._request("ZoneGroupTopology", TOPOLOGY_ENDPOINT, action, variables); }

    async play(options) {
        if (!options) {
            await this._avTransport("Play", { InstanceID: 0, Speed: 1 });
            return true;
        }
        const result = await this.queue(options);
        await this.selectQueue();
        await this.selectTrack(result.FirstTrackNumberEnqueued);
        await this._avTransport("Play", { InstanceID: 0, Speed: 1 });
        return true;
    }

    async stop() {
        await this._avTransport("Stop", { InstanceID: 0 });
        return true;
    }

    async seek(seconds) {
        let hh = Math.floor(seconds / 3600);
        let mm = Math.floor((seconds - (hh * 3600)) / 60);
        let ss = seconds - ((hh * 3600) + (mm * 60));
        if (hh < 10) hh = "0" + hh;
        if (mm < 10) mm = "0" + mm;
        if (ss < 10) ss = "0" + ss;
        await this._avTransport("Seek", { InstanceID: 0, Unit: "REL_TIME", Target: hh + ":" + mm + ":" + ss });
        return true;
    }

    async selectTrack(trackNr) {
        await this._avTransport("Seek", { InstanceID: 0, Unit: "TRACK_NR", Target: trackNr });
        return true;
    }

    async selectQueue() {
        const info = await this.getZoneInfo();
        const uri = "x-rincon-queue:RINCON_" + info.MACAddress.replace(/:/g, "") + "0" + this.port + "#0";
        return this.setAVTransportURI(uri);
    }

    async queue(options, positionInQueue = 0) {
        if (typeof options === "string") options = generateMetadata(options, undefined, this.options.spotify.region);
        return this._avTransport("AddURIToQueue", {
            InstanceID: 0,
            EnqueuedURI: encodeXml(options.uri),
            EnqueuedURIMetaData: encodeXml(options.metadata),
            DesiredFirstTrackNumberEnqueued: positionInQueue,
            EnqueueAsNext: 1
        });
    }

    async setAVTransportURI(options) {
        if (typeof options !== "string" && typeof options !== "object") {
            return new Error("Options should be an object or a string");
        }
        if (typeof options === "string") options = generateMetadata(options, undefined, this.options.spotify.region);
        if (!options.uri) return new Error("Error with uri");
        const result = await this._avTransport("SetAVTransportURI", {
            InstanceID: 0,
            CurrentURI: encodeXml(options.uri),
            CurrentURIMetaData: encodeXml(options.metadata)
        });
        // Start playing by default, the notifications don't want to start playing by default.
        if ((!options.onlySetUri || options.onlySetUri !== true) && result) return this.play();
        return true;
    }

    async getVolume() {
        const result = await this._renderingControl("GetVolume", { InstanceID: 0, Channel: "Master" });
        return parseInt(result.CurrentVolume, 10);
    }

    async setVolume(volume, channel = "Master") {
        return this._renderingControl("SetVolume", { InstanceID: 0, Channel: channel, DesiredVolume: volume });
    }

    async getMuted() {
        const result = await this._renderingControl("GetMute", { InstanceID: 0, Channel: "Master" });
        return !!parseInt(result.CurrentMute, 10);
    }

    async setMuted(muted, channel = "Master") {
        if (typeof muted === "string") muted = !!parseInt(muted, 10);
        return this._renderingControl("SetMute", { InstanceID: 0, Channel: channel, DesiredMute: (muted ? "1" : "0") });
    }

    async getCurrentState() {
        const result = await this._avTransport("GetTransportInfo", { InstanceID: 0 });
        return translateState(result.CurrentTransportState);
    }

    async currentTrack() {
        const result = await this._avTransport("GetPositionInfo", { InstanceID: 0 });
        result.Track = parseInt(result.Track);
        const position = timeToSeconds(result.RelTime);
        const duration = timeToSeconds(result.TrackDuration);
        const trackUri = result.TrackURI || null;
        const queuePosition = parseInt(result.Track);
        if (result.TrackMetaData && result.TrackMetaData !== "NOT_IMPLEMENTED") {
            const track = parseDIDL(parseXml(result.TrackMetaData));
            track.position = position;
            track.duration = duration;
            track.albumArtURL = !track.albumArtURI
                ? null
                : track.albumArtURI.startsWith("http")
                    ? track.albumArtURI
                    : "http://" + this.host + ":" + this.port + track.albumArtURI;
            if (trackUri) track.uri = trackUri;
            track.queuePosition = queuePosition;
            return track;
        }
        return { position, duration, queuePosition, uri: trackUri };
    }

    async getZoneAttrs() {
        return this._deviceProperties("GetZoneAttributes");
    }

    async getZoneInfo() {
        return this._deviceProperties("GetZoneInfo");
    }

    async getName() {
        const attrs = await this.getZoneAttrs();
        return attrs.CurrentZoneName;
    }

    async getAllGroups() {
        const state = await this._zoneGroupTopology("GetZoneGroupState", {});
        let zoneGroupState = parseXml(state.ZoneGroupState);
        if (zoneGroupState.ZoneGroupState) zoneGroupState = zoneGroupState.ZoneGroupState;
        let groups = zoneGroupState.ZoneGroups.ZoneGroup;
        if (!Array.isArray(groups)) groups = [groups];
        for (let i = 0; i < groups.length; i++) {
            if (!Array.isArray(groups[i].ZoneGroupMember)) groups[i].ZoneGroupMember = [groups[i].ZoneGroupMember];
        }
        groups.forEach((zone) => {
            if (zone.Coordinator) {
                const coordinator = zone.ZoneGroupMember.find((member) => member.UUID === zone.Coordinator);
                if (coordinator) {
                    zone.Name = coordinator.ZoneName;
                    if (zone.ZoneGroupMember.length > 1) zone.Name += ` + ${zone.ZoneGroupMember.length - 1}`;
                    const uri = new URL(coordinator.Location);
                    zone.host = uri.hostname;
                    zone.port = parseInt(uri.port);
                    zone.CoordinatorDevice = function () {
                        return new Sonos(this.host, this.port);
                    };
                }
            } else if (zone.ZoneGroupMember.length > 0) {
                zone.Name = zone.ZoneGroupMember[0].ZoneName;
            }
        });
        return groups;
    }

    // Join the group of another device, by its zone name (it doesn't need to be the coordinator).
    async joinGroup(otherDeviceName) {
        const groups = await this.getAllGroups();
        const groupToJoin = groups.find(group =>
            group.ZoneGroupMember.some(member => member.ZoneName.toLowerCase() === otherDeviceName.toLowerCase()));
        if (!groupToJoin) return new Error(`Device with name ${otherDeviceName} isn't found`);
        return this.setAVTransportURI({ uri: `x-rincon:${groupToJoin.Coordinator}`, onlySetUri: true });
    }

    async leaveGroup() {
        return this.becomeCoordinatorOfStandaloneGroup();
    }

    async becomeCoordinatorOfStandaloneGroup() {
        await this._avTransport("BecomeCoordinatorOfStandaloneGroup", { InstanceID: 0 });
        return true;
    }
}

// ######################################################
// SSDP discovery (ported from sonos/lib/deviceDiscovery.js and asyncDeviceDiscovery.js)

const PLAYER_SEARCH = Buffer.from(["M-SEARCH * HTTP/1.1",
    "HOST: 239.255.255.250:1900",
    "MAN: ssdp:discover",
    "MX: 1",
    "ST: urn:schemas-upnp-org:device:ZonePlayer:1"].join("\r\n"));

// Emits "DeviceAvailable" (sonos, model), "timeout" and "error".
class DeviceDiscovery extends EventEmitter {
    constructor(options) {
        super();
        const opts = options || {};
        this.foundSonosDevices = {};
        this.socket = dgram.createSocket("udp4", (buffer, rinfo) => {
            const text = buffer.toString();
            if (text.match(/.+Sonos.+/)) {
                const modelCheck = text.match(/SERVER.*\((.*)\)/);
                const model = (modelCheck && modelCheck.length > 1 ? modelCheck[1] : null);
                const addr = rinfo.address;
                if (!(addr in this.foundSonosDevices)) {
                    const sonos = this.foundSonosDevices[addr] = new Sonos(addr);
                    this.emit("DeviceAvailable", sonos, model);
                }
            }
        });
        this.socket.on("close", () => {
            clearTimeout(this.searchTimer);
            clearTimeout(this.pollTimer);
        });
        this.socket.on("error", (err) => this.emit("error", err));
        const sendDiscover = () => {
            (opts.addresses || ["239.255.255.250", "255.255.255.255"]).forEach((addr) => {
                this.socket.send(PLAYER_SEARCH, 0, PLAYER_SEARCH.length, opts.searchPort || 1900, addr);
            });
            // Periodically send discover packet to find newly added devices
            this.pollTimer = setTimeout(sendDiscover, 10000);
        };
        this.socket.bind({ port: opts.port, address: opts.address }, () => {
            this.socket.setBroadcast(true);
            sendDiscover();
        });
        if (opts.timeout) {
            this.searchTimer = setTimeout(() => {
                this.socket.close();
                this.emit("timeout");
            }, opts.timeout);
        }
    }

    destroy(callback) {
        clearTimeout(this.searchTimer);
        clearTimeout(this.pollTimer);
        this.socket.close(callback);
    }
}

class AsyncDeviceDiscovery {
    // Resolves with the first Sonos device that answers.
    async discover(options = { timeout: 5000 }) {
        return new Promise((resolve, reject) => {
            const discovery = new DeviceDiscovery(options);
            discovery.once("DeviceAvailable", (device) => {
                discovery.destroy();
                resolve(device);
            });
            discovery.once("timeout", () => reject(new Error("No device found")));
            discovery.once("error", (err) => { try { discovery.destroy(); } catch (e) { } reject(err); });
        });
    }

    async discoverMultiple(options = { timeout: 5000 }) {
        return new Promise((resolve, reject) => {
            const discovery = new DeviceDiscovery(options);
            const devices = [];
            discovery.on("DeviceAvailable", (device) => devices.push(device));
            discovery.once("timeout", () => {
                if (devices.length > 0) resolve(devices);
                else reject(new Error("No devices found"));
            });
            discovery.once("error", (err) => { try { discovery.destroy(); } catch (e) { } reject(err); });
        });
    }
}

module.exports = { Sonos, AsyncDeviceDiscovery, DeviceDiscovery, generateMetadata, encodeXml };
