// Discover DLNA / UPnP MediaRenderer devices on the local network.
// Prints the device description XML URL (LOCATION) to paste into the
// tts-ultimate "DLNA / UPnP renderer" player configuration.
//
// Usage:
//   node scripts/discover-dlna.js            (search ~5s)
//   node scripts/discover-dlna.js --timeout 8000
const { discoverRenderers } = require("../ttsultimate/lib/dlna-discovery");

const argValue = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : fallback;
};

const timeoutMs = Number(argValue("--timeout", 5000)) || 5000;

(async () => {
  // eslint-disable-next-line no-console
  console.log(`Searching for DLNA/UPnP MediaRenderers for ${timeoutMs} ms...\n`);
  const devices = await discoverRenderers({ timeoutMs });
  if (devices.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No MediaRenderer devices found. Make sure a renderer is on and on the same subnet.");
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.log(`Found ${devices.length} renderer(s):\n`);
  for (const dev of devices) {
    // eslint-disable-next-line no-console
    console.log("  " + (dev.name || "(unknown name)"));
    // eslint-disable-next-line no-console
    console.log("    Description URL (paste this in the node): " + dev.location);
    if (dev.server) console.log("    Server: " + dev.server);
    // eslint-disable-next-line no-console
    console.log("");
  }
  process.exit(0);
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
