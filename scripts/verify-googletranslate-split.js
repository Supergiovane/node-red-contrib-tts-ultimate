const fs = require("fs");
const path = require("path");
const GoogleTranslate = require("google-translate-tts");

const GOOGLE_TRANSLATE_MAX_CHARS = 200;

const argValue = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
};

const flagEnabled = (name) => process.argv.includes(name);

const help = () => {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  node scripts/verify-googletranslate-split.js --voice it-IT --text "..." --out ./out.mp3

Options:
  --voice   Voice code (default: it-IT)
  --text    Text to synthesize (default: long sample text)
  --out     Output file path (default: ./googletranslate-split.mp3)
  --slow    Enable slow speaking
  --help    Show help
`);
};

const stripId3v2 = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return buffer;
  if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return buffer; // "ID3"
  const size =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f);
  const tagEnd = 10 + size;
  if (tagEnd <= 10 || tagEnd >= buffer.length) return buffer;
  return buffer.subarray(tagEnd);
};

const splitText = (text, maxLen) => {
  const chunks = [];
  let remaining = (text ?? "").toString().trim();
  if (remaining === "") return chunks;

  const breakChars = ["\n", ".", "!", "?", ";", ":", ",", " "];
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen + 1);
    let breakAt = -1;
    for (const ch of breakChars) {
      const idx = window.lastIndexOf(ch);
      if (idx > breakAt) breakAt = idx;
    }
    if (breakAt <= 0) breakAt = maxLen;
    const cutAt = breakAt === maxLen ? maxLen : breakAt + 1;
    const chunk = remaining.slice(0, cutAt).trim();
    if (chunk !== "") chunks.push(chunk);
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining !== "") chunks.push(remaining);
  return chunks;
};

const isLikelyMp3 = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true; // "ID3"
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true; // frame sync
  return false;
};

const main = async () => {
  if (flagEnabled("--help")) {
    help();
    process.exit(0);
  }

  const voice = argValue("--voice", "it-IT");
  const slow = flagEnabled("--slow");
  const outFile = argValue("--out", path.resolve(process.cwd(), "googletranslate-split.mp3"));
  const text = argValue(
    "--text",
    "Questo è un testo di esempio volutamente molto lungo per verificare lo split automatico in blocchi da 200 caratteri. " +
      "Il file MP3 risultante deve essere unico e riproducibile, anche se generato da più richieste consecutive al servizio di Google Translate TTS."
  );

  const resolvedVoice = typeof voice === "string" && voice.includes("-") ? voice.split("-")[0] : voice;
  const chunks = splitText(text, GOOGLE_TRANSLATE_MAX_CHARS);
  // eslint-disable-next-line no-console
  console.log(`Text length: ${text.length} chars, chunks: ${chunks.length}, voice: ${resolvedVoice}, slow: ${slow}`);

  const buffers = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunkBuffer = await GoogleTranslate.synthesize({ text: chunks[i], voice: resolvedVoice, slow });
    buffers.push(i === 0 ? chunkBuffer : stripId3v2(chunkBuffer));
  }
  const mp3 = Buffer.concat(buffers);

  if (!isLikelyMp3(mp3)) {
    throw new Error("Output does not look like an MP3 (missing ID3 header or frame sync).");
  }

  fs.writeFileSync(outFile, mp3);
  // eslint-disable-next-line no-console
  console.log(`Wrote: ${outFile} (${mp3.length} bytes)`);
};

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

