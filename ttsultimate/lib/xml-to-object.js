// Small XML to object converter for the Sonos SOAP / DIDL / ZoneGroupState documents.
// It produces the same shape as xml2js with { mergeAttrs: true, explicitArray: false },
// which is what the former "sonos" package used:
//   - an element with only text becomes a string ('' when empty)
//   - attributes and child elements become keys of an object, repeated keys become arrays
//   - text next to attributes/children goes into the "_" key
// Comments, processing instructions and DOCTYPE are skipped; entities and CDATA are decoded.

const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (match, entity) => {
        if (entity === "lt") return "<";
        if (entity === "gt") return ">";
        if (entity === "amp") return "&";
        if (entity === "quot") return "\"";
        if (entity === "apos") return "'";
        if (entity[1] === "x") return String.fromCodePoint(parseInt(entity.slice(2), 16));
        return String.fromCodePoint(parseInt(entity.slice(1), 10));
    });
}

function addValue(obj, key, value) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        obj[key] = value;
    } else if (Array.isArray(obj[key])) {
        obj[key].push(value);
    } else {
        obj[key] = [obj[key], value];
    }
}

function toValue(node) {
    const blank = /^\s*$/.test(node.text) && !node.cdata;
    if (node.attributes.length === 0 && node.children.length === 0) return node.text;
    const obj = {};
    if (!blank) obj._ = node.text;
    node.attributes.forEach(([key, value]) => addValue(obj, key, value));
    node.children.forEach((child) => addValue(obj, child.name, toValue(child)));
    return obj;
}

function newNode(name, attributeText) {
    const attributes = [];
    let m;
    ATTRIBUTE.lastIndex = 0;
    while ((m = ATTRIBUTE.exec(attributeText || "")) !== null) {
        attributes.push([m[1], decodeEntities(m[2] !== undefined ? m[2] : m[3])]);
    }
    return { name, attributes, children: [], text: "", cdata: false };
}

// Returns { rootName: value }, or null for an empty document. Throws on malformed documents.
function parseXml(xml) {
    if (typeof xml !== "string") throw new Error("XML input must be a string");
    if (/^\s*$/.test(xml)) return null;
    const stack = [];
    let root = null;
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(xml)) !== null) {
        const current = stack[stack.length - 1];
        if (m[1] !== undefined) {
            if (!current) throw new Error("CDATA outside the root element");
            current.text += m[1];
            current.cdata = true;
        } else if (m[2] !== undefined) {
            if (!current || current.name !== m[2]) throw new Error("Unexpected closing tag </" + m[2] + ">");
            stack.pop();
        } else if (m[3] !== undefined) {
            const node = newNode(m[3], m[4]);
            if (current) current.children.push(node);
            else if (root) throw new Error("More than one root element");
            else root = node;
            if (m[5] !== "/") stack.push(node);
        } else if (m[6] !== undefined) {
            if (current) current.text += decodeEntities(m[6]);
            else if (!/^\s*$/.test(m[6])) throw new Error("Text outside the root element");
        }
    }
    if (stack.length > 0) throw new Error("Unclosed tag <" + stack[stack.length - 1].name + ">");
    if (!root) throw new Error("Empty XML document");
    return { [root.name]: toValue(root) };
}

module.exports = { parseXml, decodeEntities };
