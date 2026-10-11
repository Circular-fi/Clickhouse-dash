import zlib from 'node:zlib';

// The entries of a ZIP archive, read from its central directory (a streamed entry has its sizes only there):
// [{ name, text() }]. Stored and deflated entries, with the ZIP64 fields (the export of ChDash always writes them).
const MAX32 = 0xffffffff;

export function readZip(bytes) {
  const buffer = Buffer.from(bytes);
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65_557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive: no end of central directory');
  let count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  if (at === MAX32 || count === 0xffff) {
    // ZIP64: the locator before the end record points at the ZIP64 end record.
    const locator = eocd - 20;
    if (buffer.readUInt32LE(locator) !== 0x07064b50) throw new Error('ZIP64 archive without its end locator');
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(record) !== 0x06064b50) throw new Error('bad ZIP64 end record');
    count = Number(buffer.readBigUInt64LE(record + 32));
    at = Number(buffer.readBigUInt64LE(record + 48));
  }
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central directory entry ${index}`);
    const method = buffer.readUInt16LE(at + 10);
    let compressed = buffer.readUInt32LE(at + 20);
    const uncompressed = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    let local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    // The ZIP64 extra field (id 1) holds, in this order, those of the three that are 0xffffffff.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const size = buffer.readUInt16LE(extra + 2);
      if (id === 1) {
        let field = extra + 4;
        if (uncompressed === MAX32) field += 8;
        if (compressed === MAX32) { compressed = Number(buffer.readBigUInt64LE(field)); field += 8; }
        if (local === MAX32) local = Number(buffer.readBigUInt64LE(field));
      }
      extra += 4 + size;
    }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    entries.push({ name, text: () => (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8') });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
