// Native Google Translate TTS implementation.
// Replaces the external "google-translate-tts" dependency.
// Exposes the same public API: { synthesize, voices }.
//
// It performs an unauthenticated POST to the Google Translate web endpoint
// (the same one the translate.google.com page uses for the "listen" button)
// and decodes the base64 MP3 audio from the response.
const https = require("https");

// ---------------------------------------------------------------------------
// Voices supported by Google Translate (free, unauthenticated) TTS.
// ---------------------------------------------------------------------------
const voices = (() => {
    // prettier-ignore
    const list = [
        { code: "af-ZA",       name: "Afrikaans" },
        { code: "sq",          name: "Albanian" },
        { code: "ar-AE",       name: "Arabic" },
        { code: "hy",          name: "Armenian" },
        { code: "bn-BD",       name: "Bengali (Bangladesh)" },
        { code: "bn-IN",       name: "Bengali (India)" },
        { code: "bs",          name: "Bosnian" },
        { code: "my",          name: "Burmese (Myanmar)" },
        { code: "ca-ES",       name: "Catalan" },
        { code: "cmn-Hant-TW", name: "Chinese" },
        { code: "hr-HR",       name: "Croatian" },
        { code: "cs-CZ",       name: "Czech" },
        { code: "da-DK",       name: "Danish" },
        { code: "nl-NL",       name: "Dutch" },
        { code: "en-AU",       name: "English (Australia)" },
        { code: "en-GB",       name: "English (United Kingdom)" },
        { code: "en-US",       name: "English (United States)" },
        { code: "eo",          name: "Esperanto" },
        { code: "et",          name: "Estonian" },
        { code: "fil-PH",      name: "Filipino" },
        { code: "fi-FI",       name: "Finnish" },
        { code: "fr-FR",       name: "French" },
        { code: "fr-CA",       name: "French (Canada)" },
        { code: "de-DE",       name: "German" },
        { code: "el-GR",       name: "Greek" },
        { code: "gu",          name: "Gujarati" },
        { code: "hi-IN",       name: "Hindi" },
        { code: "hu-HU",       name: "Hungarian" },
        { code: "is-IS",       name: "Icelandic" },
        { code: "id-ID",       name: "Indonesian" },
        { code: "it-IT",       name: "Italian" },
        { code: "ja-JP",       name: "Japanese (Japan)" },
        { code: "kn",          name: "Kannada" },
        { code: "km",          name: "Khmer" },
        { code: "ko-KR",       name: "Korean" },
        { code: "la",          name: "Latin" },
        { code: "lv",          name: "Latvian" },
        { code: "mk",          name: "Macedonian" },
        { code: "ml",          name: "Malayalam" },
        { code: "mr",          name: "Marathi" },
        { code: "ne",          name: "Nepali" },
        { code: "nb-NO",       name: "Norwegian" },
        { code: "pl-PL",       name: "Polish" },
        { code: "pt-BR",       name: "Portuguese" },
        { code: "ro-RO",       name: "Romanian" },
        { code: "ru-RU",       name: "Russian" },
        { code: "sr-RS",       name: "Serbian" },
        { code: "si",          name: "Sinhala" },
        { code: "sk-SK",       name: "Slovak" },
        { code: "es-MX",       name: "Spanish (Mexico)" },
        { code: "es-ES",       name: "Spanish (Spain)" },
        { code: "sw",          name: "Swahili" },
        { code: "sv-SE",       name: "Swedish" },
        { code: "ta",          name: "Tamil" },
        { code: "te",          name: "Telugu" },
        { code: "th-TH",       name: "Thai" },
        { code: "tr-TR",       name: "Turkish" },
        { code: "uk-UA",       name: "Ukrainian" },
        { code: "ur",          name: "Urdu" },
        { code: "vi-VN",       name: "Vietnamese" },
        { code: "cy",          name: "Welsh" }
    ];

    list.findByCode = (code) => list.find((l) => l.code === code);
    list.findByName = (name) => list.find((l) => l.name === name);

    return list;
})();

// ---------------------------------------------------------------------------
// synthesize({ text, voice, slow }) -> Promise<Buffer> (MP3 audio)
// ---------------------------------------------------------------------------
const requestOptions = {
    headers: {
        "content-type": "application/x-www-form-urlencoded",
    },
    hostname: "translate.google.com",
    method: "POST",
    path: "/_/TranslateWebserverUi/data/batchexecute",
};

// Builds the urlencoded "f.req" body expected by the batchexecute endpoint.
const buildBody = ({ slow = false, text, voice }) => {
    const values = JSON.stringify([text, voice, slow ? true : null, "null"]);
    const data = JSON.stringify([[["jQ1olc", values, null, "generic"]]]);
    const params = new URLSearchParams({ "f.req": data });
    return params.toString();
};

const httpRequest = (opts) =>
    new Promise((resolve, reject) => {
        const req = https.request(requestOptions, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.write(buildBody(opts));
        req.end();
    });

/* Response looks like:
 *
 *   )]}'
 *
 *   [["wrb.fr","jQ1olc","[\"<base 64 data>\"]"]]
 *   ,["di",52]
 *   ,["af.httprm",51,"8692744518077823928",2]
 *   ]
 */
const toBuffer = (response) => {
    const slice = response.split("\n").slice(1).join("");
    const json = JSON.parse(slice);
    const dataString = json[0][2];
    const dataArray = JSON.parse(dataString);

    if (dataArray === null)
        throw new Error("Unable to parse audio data. Check your request params.");

    return Buffer.from(dataArray[0], "base64");
};

const synthesize = (opts) => httpRequest(opts).then(toBuffer);

module.exports = { synthesize, voices };
