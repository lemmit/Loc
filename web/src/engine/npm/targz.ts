// gzip + tar for the npm-in-browser engine (Phase B3).
//
// Zero new deps: `DecompressionStream("gzip")` is a Web/Node-18+
// global, so the same code runs in the bundler worker and in the
// tsx spike.  The tar walk is the minimal ustar reader the B1/B2
// spikes validated against real npm tarballs.

export interface TarEntry {
  /** Path with the leading `package/` stripped (npm tarball convention). */
  name: string;
  data: Uint8Array;
}

export async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function untar(tar: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  const dec = new TextDecoder();
  for (let off = 0; off + 512 <= tar.length; ) {
    const block = tar.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive
    const name = dec.decode(block.subarray(0, 100)).replace(/\0.*$/, "");
    const prefix = dec.decode(block.subarray(345, 500)).replace(/\0.*$/, "");
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(dec.decode(block.subarray(124, 136)).trim(), 8) || 0;
    const type = String.fromCharCode(block[156]);
    const dataOff = off + 512;
    if (type === "0" || type === "") {
      out.push({
        name: full.replace(/^package\//, ""),
        data: tar.subarray(dataOff, dataOff + size),
      });
    }
    off = dataOff + Math.ceil(size / 512) * 512;
  }
  return out;
}
