// Minimal native Google Cast (CASTV2) sender: connects to a Chromecast / Google Nest,
// launches the Default Media Receiver and loads an audio URL.
// It replaces the unmaintained castv2-client / castv2 packages (and their old protobufjs).
//
// Protocol: TLS on port 8009, every message is a 4-byte big-endian length followed by a
// protobuf "CastMessage". The message is small and fixed, so it is encoded by hand:
//   1 protocol_version (varint, CASTV2_1_0 = 0)   2 source_id (string)
//   3 destination_id (string)                      4 namespace (string)
//   5 payload_type (varint, STRING = 0)            6 payload_utf8 (string)
//   7 payload_binary (bytes, unused here)
const tls = require("tls");
const { EventEmitter } = require("events");

const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA = "urn:x-cast:com.google.cast.media";
const DEFAULT_MEDIA_RECEIVER_APP_ID = "CC1AD845";
const SENDER_ID = "sender-0";
const RECEIVER_ID = "receiver-0";
const HEARTBEAT_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;

function encodeVarint(value) {
    const bytes = [];
    let v = value >>> 0;
    while (v > 0x7f) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    bytes.push(v);
    return Buffer.from(bytes);
}

function encodeStringField(fieldNumber, value) {
    const data = Buffer.from(value, "utf8");
    return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(data.length), data]);
}

function encodeMessage({ sourceId, destinationId, namespace, payload }) {
    return Buffer.concat([
        encodeVarint((1 << 3) | 0), encodeVarint(0),
        encodeStringField(2, sourceId),
        encodeStringField(3, destinationId),
        encodeStringField(4, namespace),
        encodeVarint((5 << 3) | 0), encodeVarint(0),
        encodeStringField(6, payload)
    ]);
}

function decodeVarint(buffer, offset) {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buffer.length) {
        const byte = buffer[pos++];
        result += (byte & 0x7f) * Math.pow(2, shift);
        if ((byte & 0x80) === 0) return { value: result, next: pos };
        shift += 7;
    }
    throw new Error("truncated varint");
}

function decodeMessage(buffer) {
    const message = {};
    let pos = 0;
    while (pos < buffer.length) {
        const key = decodeVarint(buffer, pos);
        pos = key.next;
        const fieldNumber = Math.floor(key.value / 8);
        const wireType = key.value & 7;
        if (wireType === 0) {
            const v = decodeVarint(buffer, pos);
            pos = v.next;
            if (fieldNumber === 1) message.protocolVersion = v.value;
            if (fieldNumber === 5) message.payloadType = v.value;
        } else if (wireType === 2) {
            const len = decodeVarint(buffer, pos);
            const data = buffer.subarray(len.next, len.next + len.value);
            if (data.length !== len.value) throw new Error("truncated field");
            pos = len.next + len.value;
            if (fieldNumber === 2) message.sourceId = data.toString("utf8");
            if (fieldNumber === 3) message.destinationId = data.toString("utf8");
            if (fieldNumber === 4) message.namespace = data.toString("utf8");
            if (fieldNumber === 6) message.payload = data.toString("utf8");
        } else if (wireType === 5) {
            pos += 4;
        } else if (wireType === 1) {
            pos += 8;
        } else {
            throw new Error("unsupported wire type " + wireType);
        }
    }
    return message;
}

// Events: "status" (media status object), "error", "close".
class CastClient extends EventEmitter {
    // options.connect(host, port, onConnect) -> socket. Defaults to TLS (Cast devices use self-signed certificates).
    constructor(options) {
        super();
        const opts = options || {};
        this._connect = opts.connect || ((host, port, onConnect) => tls.connect({ host, port, rejectUnauthorized: false }, onConnect));
        this._socket = null;
        this._buffer = Buffer.alloc(0);
        this._requestId = 0;
        this._pending = new Map(); // requestId -> { resolve, reject, timer }
        this._heartbeat = null;
        this._closed = false;
    }

    connect(host, port) {
        return new Promise((resolve, reject) => {
            let connected = false;
            const socket = this._connect(host, port || 8009, () => {
                connected = true;
                this._send(SENDER_ID, RECEIVER_ID, NS_CONNECTION, { type: "CONNECT" });
                this._heartbeat = setInterval(() => this._send(SENDER_ID, RECEIVER_ID, NS_HEARTBEAT, { type: "PING" }), HEARTBEAT_INTERVAL_MS);
                resolve();
            });
            this._socket = socket;
            socket.on("data", (chunk) => this._onData(chunk));
            socket.on("error", (err) => {
                if (!connected) reject(err);
                else this._fail(err);
            });
            socket.on("close", () => {
                if (!connected) reject(new Error("Google Cast: connection closed"));
                else this._fail(new Error("Google Cast: connection closed by the device"));
            });
        });
    }

    async setVolume(level) {
        return this._request(RECEIVER_ID, NS_RECEIVER, { type: "SET_VOLUME", volume: { level } });
    }

    // Launches (or joins) the Default Media Receiver and opens a virtual connection to it.
    async launchDefaultMediaReceiver() {
        const response = await this._request(RECEIVER_ID, NS_RECEIVER, { type: "LAUNCH", appId: DEFAULT_MEDIA_RECEIVER_APP_ID });
        if (response.type !== "RECEIVER_STATUS") throw new Error("Google Cast: launch failed (" + (response.reason || response.type) + ")");
        const apps = (response.status && response.status.applications) || [];
        const app = apps.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER_APP_ID);
        if (!app) throw new Error("Google Cast: Default Media Receiver not running after launch");
        this._send(SENDER_ID, app.transportId, NS_CONNECTION, { type: "CONNECT" });
        return { transportId: app.transportId, sessionId: app.sessionId };
    }

    async load(app, media, autoplay) {
        const response = await this._request(app.transportId, NS_MEDIA, { type: "LOAD", sessionId: app.sessionId, media, autoplay: autoplay !== false, currentTime: 0 });
        if (response.type !== "MEDIA_STATUS") throw new Error("Google Cast: load failed (" + (response.reason || response.type) + ")");
        return response;
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        clearInterval(this._heartbeat);
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Google Cast: client closed"));
        }
        this._pending.clear();
        if (this._socket) {
            try { this._send(SENDER_ID, RECEIVER_ID, NS_CONNECTION, { type: "CLOSE" }); } catch (e) { }
            this._socket.removeAllListeners("close");
            this._socket.on("error", () => { });
            // end() flushes the CLOSE message; destroy later in case the device never closes its side.
            const socket = this._socket;
            socket.end();
            setTimeout(() => socket.destroy(), 1000).unref();
        }
    }

    _fail(err) {
        if (this._closed) return;
        this.close();
        this.emit("error", err);
    }

    _send(sourceId, destinationId, namespace, data) {
        if (!this._socket || this._socket.destroyed) return;
        const body = encodeMessage({ sourceId, destinationId, namespace, payload: JSON.stringify(data) });
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length, 0);
        this._socket.write(Buffer.concat([header, body]));
    }

    _request(destinationId, namespace, data) {
        return new Promise((resolve, reject) => {
            if (this._closed) { reject(new Error("Google Cast: client closed")); return; }
            const requestId = ++this._requestId;
            const timer = setTimeout(() => {
                this._pending.delete(requestId);
                reject(new Error("Google Cast: no answer to " + data.type));
            }, REQUEST_TIMEOUT_MS);
            this._pending.set(requestId, { resolve, reject, timer });
            this._send(SENDER_ID, destinationId, namespace, Object.assign({}, data, { requestId }));
        });
    }

    _onData(chunk) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        while (this._buffer.length >= 4) {
            const length = this._buffer.readUInt32BE(0);
            if (this._buffer.length < 4 + length) return;
            const frame = this._buffer.subarray(4, 4 + length);
            this._buffer = this._buffer.subarray(4 + length);
            let message;
            let data;
            try {
                message = decodeMessage(frame);
                data = message.payload ? JSON.parse(message.payload) : {};
            } catch (error) {
                continue; // ignore malformed or binary messages
            }
            this._onMessage(message, data);
        }
    }

    _onMessage(message, data) {
        if (message.namespace === NS_HEARTBEAT) {
            if (data.type === "PING") this._send(SENDER_ID, message.sourceId, NS_HEARTBEAT, { type: "PONG" });
            return;
        }
        if (message.namespace === NS_CONNECTION) {
            if (data.type === "CLOSE") this._fail(new Error("Google Cast: the receiver closed the connection"));
            return;
        }
        if (message.namespace === NS_MEDIA && data.type === "MEDIA_STATUS" && Array.isArray(data.status) && data.status[0]) {
            this.emit("status", data.status[0]);
        }
        const pending = data.requestId ? this._pending.get(data.requestId) : undefined;
        if (pending) {
            this._pending.delete(data.requestId);
            clearTimeout(pending.timer);
            pending.resolve(data);
        }
    }
}

module.exports = { CastClient, encodeMessage, decodeMessage, DEFAULT_MEDIA_RECEIVER_APP_ID };
