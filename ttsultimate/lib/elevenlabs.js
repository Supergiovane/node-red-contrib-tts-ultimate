// Minimal ElevenLabs REST client (voices list + text to speech).
// It replaces the deprecated "elevenlabs" and "elevenlabs-node" packages and uses only the
// built-in fetch, sending the same requests those packages sent.
const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1";

async function request(apiKey, urlPath, options) {
    const res = await fetch(ELEVENLABS_API_BASE_URL + urlPath, Object.assign({}, options, {
        headers: Object.assign({ "xi-api-key": apiKey }, options && options.headers)
    }));
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ElevenLabs HTTP ${res.status} ${res.statusText}${body ? " - " + body : ""}`);
    }
    return res;
}

// Returns the raw voice objects ({ voice_id, name, labels, ... }).
async function getVoices(apiKey) {
    const res = await request(apiKey, "/voices", { method: "GET" });
    const json = await res.json();
    return Array.isArray(json.voices) ? json.voices : [];
}

// Voice ids are 20 alphanumeric chars; anything else is looked up by voice name (like the old SDK did).
function isVoiceId(value) {
    return /^[a-zA-Z0-9]{20}$/.test(value);
}

async function resolveVoiceId(apiKey, voiceIdOrName) {
    if (isVoiceId(voiceIdOrName)) return voiceIdOrName;
    const voice = (await getVoices(apiKey)).find((v) => v.name === voiceIdOrName);
    if (!voice) throw new Error(`ElevenLabs: ${voiceIdOrName} is not a valid voice name`);
    return voice.voice_id;
}

// params: { text, voice, model_id, voice_settings, seed, optimize_streaming_latency, output_format }
// as built by the TTS-Ultimate node. Returns the audio as a Buffer.
async function textToSpeech(apiKey, params) {
    const voiceId = await resolveVoiceId(apiKey, params.voice);
    const body = { text: params.text };
    if (params.model_id !== undefined) body.model_id = params.model_id;
    if (params.voice_settings !== undefined) body.voice_settings = params.voice_settings;
    if (params.seed !== undefined) body.seed = params.seed;
    const query = new URLSearchParams();
    if (params.optimize_streaming_latency !== undefined) query.set("optimize_streaming_latency", String(params.optimize_streaming_latency));
    if (params.output_format !== undefined) query.set("output_format", String(params.output_format));
    const qs = query.toString();
    const res = await request(apiKey, `/text-to-speech/${encodeURIComponent(voiceId)}${qs ? "?" + qs : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body)
    });
    return Buffer.from(await res.arrayBuffer());
}

module.exports = { ELEVENLABS_API_BASE_URL, getVoices, isVoiceId, textToSpeech };
