// electron-builder afterPack hook: runs after the app is assembled and before it's signed.
//
// macOS identifies an app for local network privacy by its main executable's Mach-O UUID, not its
// bundle ID (Apple TN3179). Every app built on the same Electron version ships the same prebuilt
// executable, so they all share one UUID: Airlock looked like the plain "Electron" app used when
// running from source, and macOS never asked for, or listed, Airlock's own permission. So ping,
// ssh and curl to local addresses failed from its terminal.
//
// This gives the executable a UUID of its own, derived from the app ID so it stays the same in
// every release, and a permission granted once survives updates.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;

// A version-5-style UUID from the app ID: stable, and unlike any other app's.
function uuidFor(appId) {
  const bytes = crypto.createHash('sha256').update(`airlock-terminal:${appId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

// Rewrites LC_UUID in the 64-bit Mach-O image at `offset`. Returns how many were changed.
function rewriteImage(buf, offset, uuid) {
  if (buf.readUInt32LE(offset) !== MH_MAGIC_64) return 0;
  const ncmds = buf.readUInt32LE(offset + 16);
  let at = offset + 32; // past mach_header_64
  let changed = 0;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(at);
    const size = buf.readUInt32LE(at + 4);
    if (cmd === LC_UUID) {
      uuid.copy(buf, at + 8);
      changed++;
    }
    at += size;
  }
  return changed;
}

function setUuid(file, uuid) {
  const buf = fs.readFileSync(file);
  let changed = 0;
  if (buf.readUInt32BE(0) === FAT_MAGIC) { // universal binary: every architecture
    const count = buf.readUInt32BE(4);
    for (let i = 0; i < count; i++) changed += rewriteImage(buf, buf.readUInt32BE(8 + i * 20 + 8), uuid);
  } else {
    changed = rewriteImage(buf, 0, uuid);
  }
  if (!changed) throw new Error(`no LC_UUID found in ${file}`);
  fs.writeFileSync(file, buf);
  return changed;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { productFilename, info } = context.packager.appInfo;
  const appId = context.packager.config.appId ?? info?.appId ?? productFilename;
  const exe = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  const uuid = uuidFor(appId);
  setUuid(exe, uuid);
  const hex = uuid.toString('hex').toUpperCase();
  console.log(`  • set Mach-O UUID  ${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
};
