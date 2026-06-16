// Minimal native DLNA / UPnP MediaRenderer control client.
// Unlike upnp-mediarenderer-client, it locates the AVTransport / RenderingControl
// services anywhere in the device tree (root device OR embedded <deviceList> devices),
// so it also works with renderers that nest a MediaRenderer sub-device (e.g. Sonos).
//
// It uses only the built-in http module (no XML parser dependency): the UPnP
// description and SOAP responses are simple enough to read with focused regexes.
const http = require("http");
const { URL } = require("url");

function httpRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(new Error("request timeout")); });
        if (body) req.write(body);
        req.end();
    });
}

function getText(xml, tag) {
    const m = xml.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
    return m ? m[1].trim() : "";
}

function escapeXml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// Fetch the device description and resolve the (absolute) control URLs for
// AVTransport and RenderingControl, scanning every <service> in the document.
async function resolveServices(descriptionUrl) {
    let u;
    try {
        u = new URL(descriptionUrl);
    } catch (e) {
        throw new Error('invalid DLNA renderer URL "' + descriptionUrl + '": use the full device description XML URL (e.g. http://192.168.1.50:49153/nmrDescription.xml), not just the IP address');
    }
    if (!/^https?:$/.test(u.protocol)) {
        throw new Error('DLNA renderer URL must start with http:// (got "' + descriptionUrl + '")');
    }
    const res = await httpRequest({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "GET",
        timeout: 5000
    });
    if (!res.body) throw new Error("empty device description");
    const xml = res.body;
    const urlBase = getText(xml, "URLBase");
    const base = urlBase || descriptionUrl;

    const services = {};
    const svcRe = /<service>([\s\S]*?)<\/service>/g;
    let m;
    while ((m = svcRe.exec(xml)) !== null) {
        const block = m[1];
        const type = getText(block, "serviceType");
        const ctrl = getText(block, "controlURL");
        if (!type || !ctrl) continue;
        const controlURL = new URL(ctrl, base).href;
        // Match exact service ids; ":service:RenderingControl:" will not match "GroupRenderingControl".
        if (/:service:AVTransport:\d/i.test(type) && !services.AVTransport) {
            services.AVTransport = { type, controlURL };
        } else if (/:service:RenderingControl:\d/i.test(type) && !services.RenderingControl) {
            services.RenderingControl = { type, controlURL };
        }
    }
    if (!services.AVTransport) throw new Error("AVTransport service not found in device description");
    return services;
}

function soapAction(controlURL, serviceType, action, argsXml) {
    const u = new URL(controlURL);
    const body =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
        "<s:Body>" +
        '<u:' + action + ' xmlns:u="' + serviceType + '">' + argsXml + "</u:" + action + ">" +
        "</s:Body></s:Envelope>";
    return httpRequest({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "POST",
        timeout: 8000,
        headers: {
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPACTION": '"' + serviceType + "#" + action + '"',
            "Content-Length": Buffer.byteLength(body)
        }
    }, body).then((res) => {
        if (res.statusCode >= 400) {
            const errCode = getText(res.body, "errorCode");
            throw new Error("SOAP " + action + " failed: HTTP " + res.statusCode + (errCode ? " (UPnP error " + errCode + ")" : ""));
        }
        return res.body;
    });
}

function buildDidl(url, contentType) {
    const protocolInfo = "http-get:*:" + (contentType || "audio/mpeg") + ":*";
    return (
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
        '<item id="0" parentID="-1" restricted="1">' +
        "<dc:title>TTS</dc:title>" +
        "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
        '<res protocolInfo="' + protocolInfo + '">' + escapeXml(url) + "</res>" +
        "</item></DIDL-Lite>"
    );
}

// createPlayer(descriptionUrl) -> { setVolume, setAVTransportURI, play, getTransportState }
function createPlayer(descriptionUrl) {
    let servicesPromise = null;
    const getServices = () => {
        if (!servicesPromise) servicesPromise = resolveServices(descriptionUrl);
        return servicesPromise;
    };

    return {
        async setVolume(volume0to100) {
            const svc = await getServices();
            if (!svc.RenderingControl) return; // not all renderers expose volume control
            const args =
                "<InstanceID>0</InstanceID><Channel>Master</Channel>" +
                "<DesiredVolume>" + Math.max(0, Math.min(100, Math.round(volume0to100))) + "</DesiredVolume>";
            return soapAction(svc.RenderingControl.controlURL, svc.RenderingControl.type, "SetVolume", args);
        },
        async setAVTransportURI(url, contentType) {
            const svc = await getServices();
            const didl = buildDidl(url, contentType);
            const args =
                "<InstanceID>0</InstanceID>" +
                "<CurrentURI>" + escapeXml(url) + "</CurrentURI>" +
                "<CurrentURIMetaData>" + escapeXml(didl) + "</CurrentURIMetaData>";
            return soapAction(svc.AVTransport.controlURL, svc.AVTransport.type, "SetAVTransportURI", args);
        },
        async play() {
            const svc = await getServices();
            return soapAction(svc.AVTransport.controlURL, svc.AVTransport.type, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
        },
        async getTransportState() {
            const svc = await getServices();
            const bodyXml = await soapAction(svc.AVTransport.controlURL, svc.AVTransport.type, "GetTransportInfo", "<InstanceID>0</InstanceID>");
            return getText(bodyXml, "CurrentTransportState");
        }
    };
}

module.exports = { createPlayer, resolveServices };
