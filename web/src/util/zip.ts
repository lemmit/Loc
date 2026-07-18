// Minimal ZIP writer — enough to package the generated project tree as a
// single downloadable archive.  STORE only (no compression): generated
// projects are small text trees, so the size win from DEFLATE isn't worth a
// compression dependency, and a store-only archive is trivially verifiable
// (every offset is explicit).  Pure + browser-safe — no Node, no deps.
//
// Implements the PKZIP APPNOTE subset every unzip understands: a local file
// header + data per entry, a central directory, and an end-of-central-
// directory record.  Filenames are UTF-8 with the language-encoding flag
// (bit 11) set so non-ASCII paths round-trip.

export interface ZipEntry {
  /** Archive-relative path, forward-slashed (`src/app.ts`). */
  path: string;
  content: string;
}

// -- CRC32 (IEEE, poly 0xEDB88320) -----------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// -- little-endian byte sink ------------------------------------------------

class ByteSink {
  private parts: Uint8Array[] = [];
  private len = 0;

  get length(): number {
    return this.len;
  }

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.len += bytes.length;
  }

  u16(v: number): void {
    this.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  }

  u32(v: number): void {
    this.push(
      new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]),
    );
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

const UTF8_FLAG = 0x0800; // general-purpose bit 11: filename is UTF-8
// A fixed DOS timestamp (1980-01-01 00:00:00) keeps the archive deterministic
// — the same tree zips to the same bytes, which is exactly the property the
// rest of the toolchain relies on for diffable output.  `new Date()` is also
// deliberately avoided (it's banned in the pure cores).
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // (1980-1980)<<9 | 1<<5 | 1

interface Prepared {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** Build a store-only ZIP archive from `entries`.  Entries are written in the
 *  order given; callers that want a stable archive should sort first. */
export function makeZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const body = new ByteSink();
  const prepared: Prepared[] = [];

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.path);
    const data = enc.encode(entry.content);
    const crc = crc32(data);
    const offset = body.length;
    prepared.push({ nameBytes, data, crc, offset });

    // Local file header.
    body.u32(0x04034b50);
    body.u16(20); // version needed
    body.u16(UTF8_FLAG);
    body.u16(0); // method: store
    body.u16(DOS_TIME);
    body.u16(DOS_DATE);
    body.u32(crc);
    body.u32(data.length); // compressed size == uncompressed (store)
    body.u32(data.length);
    body.u16(nameBytes.length);
    body.u16(0); // extra length
    body.push(nameBytes);
    body.push(data);
  }

  // Central directory.
  const central = new ByteSink();
  for (const p of prepared) {
    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(UTF8_FLAG);
    central.u16(0); // method: store
    central.u16(DOS_TIME);
    central.u16(DOS_DATE);
    central.u32(p.crc);
    central.u32(p.data.length);
    central.u32(p.data.length);
    central.u16(p.nameBytes.length);
    central.u16(0); // extra length
    central.u16(0); // comment length
    central.u16(0); // disk number start
    central.u16(0); // internal attrs
    central.u32(0); // external attrs
    central.u32(p.offset); // local header offset
    central.push(p.nameBytes);
  }

  const centralBytes = central.concat();
  const bodyBytes = body.concat();

  // End of central directory.
  const eocd = new ByteSink();
  eocd.u32(0x06054b50);
  eocd.u16(0); // this disk
  eocd.u16(0); // disk with central dir start
  eocd.u16(prepared.length); // entries on this disk
  eocd.u16(prepared.length); // total entries
  eocd.u32(centralBytes.length);
  eocd.u32(bodyBytes.length); // central dir offset
  eocd.u16(0); // comment length

  const out = new Uint8Array(bodyBytes.length + centralBytes.length + eocd.length);
  out.set(bodyBytes, 0);
  out.set(centralBytes, bodyBytes.length);
  out.set(eocd.concat(), bodyBytes.length + centralBytes.length);
  return out;
}

/** Trigger a browser download of `bytes` as `filename`.  Split from `makeZip`
 *  so the archive builder stays pure/testable. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Copy into a fresh ArrayBuffer-backed view so the Blob doesn't alias a
  // possibly-larger pooled buffer.
  const blob = new Blob([bytes.slice()], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click's navigation has taken the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
