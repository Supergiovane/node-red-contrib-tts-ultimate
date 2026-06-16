// Discover DLNA / UPnP MediaRenderer devices on the local network via SSDP.
// No external dependencies: built-in dgram (UDP multicast) + http only.
const dgram = require("dgram");
const http = require("http");
const { URL } = require("url");

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const SEARCH_TARGET = "urn:schemas-upnp-org:device:MediaRenderer:1";

// Reads the <friendlyName> from a device description XML URL (best-effort).
function fetchFriendlyName(location) {
    return new Promise((resolve) => {
        try {
            const u = new URL(location);
            const req = http.get(
                { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: 3000 },
                (res) => {
                    let body = "";
                    res.on("data", (c) => (body += c));
                    res.on("end", () => {
                        const m = body.match(/<friendlyName>([^<]+)<\/friendlyName>/i);
                        resolve(m ? m[1].trim() : "");
                    });
                }
            );
            req.on("error", () => resolve(""));
            req.on("timeout", () => { req.destroy(); resolve(""); });
        } catch (e) {
            resolve("");
        }
    });
}

// discoverRenderers({ timeoutMs }) -> Promise<[{ name, location, server }]>
function discoverRenderers(options) {
    const opts = options || {};
    const timeoutMs = Number(opts.timeoutMs) || 5000;
    const withNames = opts.withNames !== false; // resolve friendlyName by default

    return new Promise((resolve, reject) => {
        const found = new Map(); // location -> { location, server }
        const mSearch = Buffer.from(
            "M-SEARCH * HTTP/1.1\r\n" +
            `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
            'MAN: "ssdp:discover"\r\n' +
            "MX: 2\r\n" +
            `ST: ${SEARCH_TARGET}\r\n` +
            "\r\n"
        );

        let socket;
        try {
            socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        } catch (error) {
            reject(error);
            return;
        }

        socket.on("message", (msg) => {
            const text = msg.toString();
            // Keep only genuine MediaRenderer responses (some non-compliant devices,
            // e.g. Hue bridges, answer any M-SEARCH; their ST/USN won't mention it).
            if (!/MediaRenderer/i.test(text)) return;
            const locationMatch = text.match(/LOCATION:\s*(.+)\r/i);
            if (!locationMatch) return;
            const location = locationMatch[1].trim();
            if (found.has(location)) return;
            const serverMatch = text.match(/SERVER:\s*(.+)\r/i);
            found.set(location, { location, server: serverMatch ? serverMatch[1].trim() : "" });
        });

        socket.on("error", (err) => {
            try { socket.close(); } catch (e) { }
            reject(err);
        });

        socket.bind(() => {
            try { socket.setBroadcast(true); } catch (e) { }
            const send = () => { try { socket.send(mSearch, 0, mSearch.length, SSDP_PORT, SSDP_ADDR); } catch (e) { } };
            send();
            setTimeout(send, 500);
            setTimeout(send, 1500);

            setTimeout(async () => {
                try { socket.close(); } catch (e) { }
                const devices = Array.from(found.values());
                if (!withNames) { resolve(devices); return; }
                for (const dev of devices) {
                    dev.name = (await fetchFriendlyName(dev.location)) || "";
                }
                resolve(devices);
            }, timeoutMs);
        });
    });
}

module.exports = { discoverRenderers, fetchFriendlyName };
