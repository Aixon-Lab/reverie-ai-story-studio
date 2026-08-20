/**
 * Dependency-free PNG tEXt chunk codec (works in browser and Node).
 * Reads/writes SillyTavern character data: `chara` (V2) and `ccv3` (V3) keywords,
 * matching ST's src/character-card-parser.js semantics.
 */

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(...buffers: Uint8Array[]): number {
  let crc = -1;
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function assertPng(bytes: Uint8Array): void {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('Not a PNG file.');
  }
}

export function extractChunks(bytes: Uint8Array): Chunk[] {
  assertPng(bytes);
  const chunks: Chunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const name = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.slice(offset + 8, offset + 8 + length);
    chunks.push({ name, data });
    offset += 12 + length; // len + name + data + crc
    if (name === 'IEND') break;
  }
  return chunks;
}

export function encodeChunks(chunks: Chunk[]): Uint8Array {
  let total = 8;
  for (const c of chunks) total += 12 + c.data.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let offset = 8;
  for (const c of chunks) {
    view.setUint32(offset, c.data.length);
    const nameBytes = new Uint8Array([...c.name].map((ch) => ch.charCodeAt(0)));
    out.set(nameBytes, offset + 4);
    out.set(c.data, offset + 8);
    view.setUint32(offset + 8 + c.data.length, crc32(nameBytes, c.data));
    offset += 12 + c.data.length;
  }
  return out;
}

function decodeTextChunk(data: Uint8Array): { keyword: string; text: string } {
  let sep = data.indexOf(0);
  if (sep === -1) sep = data.length;
  const decode = (b: Uint8Array) => {
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  };
  return { keyword: decode(data.slice(0, sep)), text: decode(data.slice(sep + 1)) };
}

function encodeTextChunk(keyword: string, text: string): Chunk {
  const bytes = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) bytes[i] = keyword.charCodeAt(i) & 0xff;
  bytes[keyword.length] = 0;
  for (let i = 0; i < text.length; i++) bytes[keyword.length + 1 + i] = text.charCodeAt(i) & 0xff;
  return { name: 'tEXt', data: bytes };
}

// base64 that works in both runtimes without Buffer
function b64encode(utf8: string): string {
  const bytes = new TextEncoder().encode(utf8);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(bin);
  return (globalThis as any).Buffer.from(bytes).toString('base64');
}

function b64decode(b64: string): string {
  // eslint-disable-next-line no-undef
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return (globalThis as any).Buffer.from(b64, 'base64').toString('utf8');
}

/** Read embedded character JSON string from a PNG. ccv3 takes precedence over chara. */
export function readCardPayload(png: Uint8Array): string {
  const texts = extractChunks(png)
    .filter((c) => c.name === 'tEXt')
    .map((c) => decodeTextChunk(c.data));
  if (texts.length === 0) throw new Error('No PNG metadata found — this PNG has no character data.');
  const ccv3 = texts.find((t) => t.keyword.toLowerCase() === 'ccv3');
  if (ccv3) return b64decode(ccv3.text);
  const chara = texts.find((t) => t.keyword.toLowerCase() === 'chara');
  if (chara) return b64decode(chara.text);
  throw new Error('PNG has no character data (chara/ccv3 chunks missing).');
}

/** Write character JSON into a PNG (both chara V2 and ccv3 V3 chunks, ST-style). */
export function writeCardPayload(png: Uint8Array, v2Json: string): Uint8Array {
  const chunks = extractChunks(png).filter((c) => {
    if (c.name !== 'tEXt') return true;
    const kw = decodeTextChunk(c.data).keyword.toLowerCase();
    return kw !== 'chara' && kw !== 'ccv3';
  });
  const insertAt = chunks.length - 1; // before IEND
  chunks.splice(insertAt, 0, encodeTextChunk('chara', b64encode(v2Json)));
  try {
    const v3 = JSON.parse(v2Json);
    v3.spec = 'chara_card_v3';
    v3.spec_version = '3.0';
    chunks.splice(insertAt + 1, 0, encodeTextChunk('ccv3', b64encode(JSON.stringify(v3))));
  } catch {
    // v3 chunk is best-effort, same as ST
  }
  return encodeChunks(chunks);
}
