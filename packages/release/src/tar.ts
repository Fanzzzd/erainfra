/**
 * A minimal, deterministic ustar + gzip writer.
 *
 * Release archives are checksummed and the checksum is what runner machines
 * trust, so the same inputs must always produce the same bytes. System `tar`
 * cannot promise that: it records mtimes, owner names, and platform-specific
 * gzip headers, and its flags for suppressing those differ between GNU tar and
 * bsdtar. Everything variable is normalized here instead:
 *
 * - entries are written in the caller's order (the packer sorts them);
 * - every mtime is 0 and every uid/gid is 0 with empty owner names;
 * - modes come from an explicit policy, never from the source file;
 * - gzip uses stored DEFLATE blocks written here, so the bytes do not depend on
 *   the Node binary's bundled zlib version.
 */

export type TarEntry = {
  /** Path inside the archive. Directory paths must end with a slash. */
  path: string;
  /** Permission bits, e.g. 0o644. */
  mode: number;
  /** File contents; must be empty for directories. */
  data: Uint8Array;
};

const BLOCK_SIZE = 512;
/** tar readers expect the archive to end on a 20-block boundary. */
const RECORD_BLOCKS = 20;
const NAME_LIMIT = 100;
const MAX_STORED_BLOCK = 0xffff;

function putString(header: Uint8Array, value: string, offset: number, size: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > size) {
    throw new Error(`Value "${value}" does not fit in ${size} bytes`);
  }
  header.set(bytes, offset);
}

/** ustar stores numbers as NUL-terminated, zero-padded octal. */
function putOctal(header: Uint8Array, value: number, offset: number, size: number) {
  const digits = value.toString(8);
  if (digits.length > size - 1) {
    throw new Error(`Value ${value} does not fit in ${size} octal bytes`);
  }
  putString(header, digits.padStart(size - 1, "0"), offset, size - 1);
}

function buildHeader(entry: TarEntry) {
  if (entry.path.length > NAME_LIMIT) {
    throw new Error(`Archive path "${entry.path}" exceeds ${NAME_LIMIT} bytes`);
  }
  const isDirectory = entry.path.endsWith("/");
  if (isDirectory && entry.data.length > 0) {
    throw new Error(`Directory entry "${entry.path}" must not carry data`);
  }

  const header = Buffer.alloc(BLOCK_SIZE);
  putString(header, entry.path, 0, NAME_LIMIT);
  putOctal(header, entry.mode & 0o7777, 100, 8);
  putOctal(header, 0, 108, 8); // uid
  putOctal(header, 0, 116, 8); // gid
  putOctal(header, entry.data.length, 124, 12);
  putOctal(header, 0, 136, 12); // mtime
  header.fill(0x20, 148, 156); // checksum placeholder: eight spaces
  putString(header, isDirectory ? "5" : "0", 156, 1);
  putString(header, "ustar", 257, 6);
  putString(header, "00", 263, 2);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  putString(header, checksum.toString(8).padStart(6, "0"), 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** Concatenate ustar headers and padded payloads into an uncompressed archive. */
export function createTar(entries: readonly TarEntry[]) {
  const blocks: Buffer[] = [];
  let blockCount = 0;
  const push = (block: Buffer) => {
    blocks.push(block);
    blockCount += block.length / BLOCK_SIZE;
  };

  for (const entry of entries) {
    push(buildHeader(entry));
    if (entry.data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(entry.data.length / BLOCK_SIZE) * BLOCK_SIZE);
      padded.set(entry.data);
      push(padded);
    }
  }

  push(Buffer.alloc(BLOCK_SIZE * 2)); // end-of-archive marker
  const trailing = blockCount % RECORD_BLOCKS;
  if (trailing !== 0) {
    push(Buffer.alloc(BLOCK_SIZE * (RECORD_BLOCKS - trailing)));
  }
  return Buffer.concat(blocks);
}

function crc32(data: Uint8Array) {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

/**
 * A DEFLATE stream made only from stored (uncompressed) blocks. Compression
 * would save roughly 80 KiB here, but zlib is part of the Node binary and has
 * produced different level-9 bytes for the same tar across supported Node 22
 * and 24 releases. Stored blocks have one canonical representation, keeping
 * the committed deployment checksum reproducible on every build host.
 */
function deflateStored(data: Uint8Array) {
  const blocks: Buffer[] = [];
  let offset = 0;
  do {
    const length = Math.min(MAX_STORED_BLOCK, data.length - offset);
    const final = offset + length === data.length;
    const header = Buffer.alloc(5);
    header[0] = final ? 1 : 0; // BFINAL plus BTYPE=00, then byte alignment.
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE(~length & MAX_STORED_BLOCK, 3);
    blocks.push(header, Buffer.from(data.subarray(offset, offset + length)));
    offset += length;
  } while (offset < data.length);
  return Buffer.concat(blocks);
}

/** Wrap deterministic stored DEFLATE blocks in a normalized gzip container. */
export function gzip(data: Uint8Array) {
  const header = Buffer.from([
    0x1f,
    0x8b, // magic
    0x08, // deflate
    0x00, // no extra fields, no name, no comment
    0x00,
    0x00,
    0x00,
    0x00, // mtime 0
    0x00, // no compression hint
    0xff, // unknown operating system
  ]);
  const body = deflateStored(data);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([header, body, trailer]);
}

export function createTarGz(entries: readonly TarEntry[]) {
  return gzip(createTar(entries));
}
