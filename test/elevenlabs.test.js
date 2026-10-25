'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const elevenlabs = require('../ttsultimate/lib/elevenlabs');

// Replaces the global fetch with a recorder that answers from a route table.
function mockFetch(t, routes) {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        const key = options.method + ' ' + url.replace(elevenlabs.ELEVENLABS_API_BASE_URL, '').split('?')[0];
        const route = routes[key];
        if (!route) return new Response('not found', { status: 404, statusText: 'Not Found' });
        return route(url, options);
    };
    t.after(() => { global.fetch = originalFetch; });
    return calls;
}

const VOICE_ID = 'AbCdEfGhIjKlMnOpQrSt';

test('getVoices returns the raw voice list and sends the API key', async (t) => {
    const calls = mockFetch(t, {
        'GET /voices': () => Response.json({ voices: [{ voice_id: VOICE_ID, name: 'Rachel', labels: { accent: 'american', gender: 'female' } }] })
    });
    const voices = await elevenlabs.getVoices('secret');
    assert.deepEqual(voices, [{ voice_id: VOICE_ID, name: 'Rachel', labels: { accent: 'american', gender: 'female' } }]);
    assert.equal(calls[0].options.headers['xi-api-key'], 'secret');
});

test('getVoices rejects with the HTTP status on errors', async (t) => {
    mockFetch(t, { 'GET /voices': () => new Response('{"detail":"invalid_api_key"}', { status: 401, statusText: 'Unauthorized' }) });
    await assert.rejects(elevenlabs.getVoices('bad'), /ElevenLabs HTTP 401 Unauthorized - \{"detail":"invalid_api_key"\}/);
});

test('textToSpeech posts the same body and query the old SDK sent', async (t) => {
    const calls = mockFetch(t, {
        ['POST /text-to-speech/' + VOICE_ID]: () => new Response(Buffer.from('mp3-bytes'))
    });
    const audio = await elevenlabs.textToSpeech('secret', {
        stream: false,
        text: 'Ciao',
        voice: VOICE_ID,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.7, use_speaker_boost: true },
        optimize_streaming_latency: '2',
        output_format: 'mp3_44100_128',
        seed: 42
    });
    assert.equal(audio.toString(), 'mp3-bytes');
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('optimize_streaming_latency'), '2');
    assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        text: 'Ciao',
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.7, use_speaker_boost: true },
        seed: 42
    });
    assert.equal(calls[0].options.headers['xi-api-key'], 'secret');
});

test('textToSpeech resolves a voice name to its id', async (t) => {
    const calls = mockFetch(t, {
        'GET /voices': () => Response.json({ voices: [{ voice_id: VOICE_ID, name: 'Rachel' }] }),
        ['POST /text-to-speech/' + VOICE_ID]: () => new Response(Buffer.from('ok'))
    });
    await elevenlabs.textToSpeech('secret', { text: 'Ciao', voice: 'Rachel' });
    assert.equal(calls.length, 2);
    await assert.rejects(elevenlabs.textToSpeech('secret', { text: 'Ciao', voice: 'Nobody' }), /Nobody is not a valid voice name/);
});
