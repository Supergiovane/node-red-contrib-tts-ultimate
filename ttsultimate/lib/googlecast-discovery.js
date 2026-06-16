// Discover Google Cast devices (Chromecast / Google Nest) on the local network
// via mDNS / DNS-SD (service "_googlecast._tcp.local").
const mdns = require("multicast-dns");

const SERVICE = "_googlecast._tcp.local";

// discoverCastDevices({ timeoutMs }) -> Promise<[{ name, host }]>
function discoverCastDevices(options) {
    const opts = options || {};
    const timeoutMs = Number(opts.timeoutMs) || 4000;

    return new Promise((resolve) => {
        let socket;
        try {
            socket = mdns();
        } catch (error) {
            resolve([]);
            return;
        }

        const srvByName = new Map(); // service instance name -> target hostname
        const fnByName = new Map();  // service instance name -> friendly name (TXT "fn=")
        const ipByHost = new Map();  // hostname -> IPv4 address

        const handleRecords = (records) => {
            (records || []).forEach((r) => {
                if (!r || !r.name) return;
                if (r.type === "SRV" && /_googlecast\._tcp/i.test(r.name) && r.data) {
                    srvByName.set(r.name, r.data.target);
                } else if (r.type === "TXT" && /_googlecast\._tcp/i.test(r.name)) {
                    const arr = Array.isArray(r.data) ? r.data : [r.data];
                    arr.forEach((entry) => {
                        const s = (entry || "").toString();
                        if (/^fn=/i.test(s)) fnByName.set(r.name, s.slice(3));
                    });
                } else if (r.type === "A" && r.data) {
                    ipByHost.set(r.name, r.data);
                }
            });
        };

        socket.on("response", (response) => {
            handleRecords(response.answers);
            handleRecords(response.additionals);
        });

        const query = () => {
            try { socket.query({ questions: [{ name: SERVICE, type: "PTR" }] }); } catch (e) { }
        };
        query();
        setTimeout(query, 800);

        setTimeout(() => {
            try { socket.destroy(); } catch (e) { }
            const devices = [];
            const seenIp = new Set();
            srvByName.forEach((target, name) => {
                const ip = ipByHost.get(target);
                if (!ip || seenIp.has(ip)) return;
                seenIp.add(ip);
                const fn = fnByName.get(name) || name.split(".")[0];
                devices.push({ name: fn, host: ip });
            });
            resolve(devices);
        }, timeoutMs);
    });
}

module.exports = { discoverCastDevices };
