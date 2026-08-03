/**
 * A minimal ustar writer/reader — just enough to move a credential file through Docker's archive API
 * (`PUT /containers/{id}/archive` takes a tar stream, there is no "write one file" endpoint). Doing
 * these ~80 lines here beats adding a tar dependency to the one service that holds the Docker socket.
 *
 * mtime is fixed at 0 throughout: these archives exist for the microseconds between building and
 * extraction, and a deterministic archive is easier to reason about than a timestamped one.
 */

export interface TarEntry {
  readonly name: string;
  /** File content; omit for a directory entry (name must then end with '/'). */
  readonly content?: Buffer;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

const BLOCK = 512;

function octal(value: number, length: number): Buffer {
  // Traditional tar numeric field: zero-padded octal, NUL-terminated.
  const text = value.toString(8).padStart(length - 1, '0');
  return Buffer.from(`${text}\0`, 'ascii');
}

function header(entry: TarEntry): Buffer {
  const size = entry.content?.length ?? 0;
  const isDir = entry.content === undefined;
  const head = Buffer.alloc(BLOCK);

  const name = Buffer.from(entry.name, 'utf8');
  if (name.length > 100) {
    throw new Error(`tar entry name too long for a ustar header: ${entry.name}`);
  }
  name.copy(head, 0);
  octal(entry.mode, 8).copy(head, 100);
  octal(entry.uid, 8).copy(head, 108);
  octal(entry.gid, 8).copy(head, 116);
  octal(size, 12).copy(head, 124);
  octal(0, 12).copy(head, 136); // mtime — deliberately 0, see module comment.
  head.fill(' ', 148, 156); // checksum field is all-spaces while the sum is being computed
  head.write(isDir ? '5' : '0', 156); // typeflag
  head.write('ustar\0', 257, 'ascii');
  head.write('00', 263, 'ascii');

  let sum = 0;
  for (const byte of head) sum += byte;
  // Checksum: 6 octal digits, NUL, space.
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(head, 148);
  return head;
}

/** Build a complete in-memory tar archive from the given entries, in order. */
export function packTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    if (entry.content !== undefined && entry.content.length > 0) {
      parts.push(entry.content);
      const overhang = entry.content.length % BLOCK;
      if (overhang !== 0) parts.push(Buffer.alloc(BLOCK - overhang));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}

export interface ExtractedEntry {
  readonly name: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly content: Buffer;
}

/** Read every file entry out of a tar archive (directories are skipped). Used by the test readback. */
export function extractTar(archive: Buffer): ExtractedEntry[] {
  const entries: ExtractedEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const head = archive.subarray(offset, offset + BLOCK);
    if (head.every((b) => b === 0)) break; // end-of-archive
    const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const mode = parseInt(head.subarray(100, 108).toString('ascii').trim() || '0', 8);
    const uid = parseInt(head.subarray(108, 116).toString('ascii').trim() || '0', 8);
    const gid = parseInt(head.subarray(116, 124).toString('ascii').trim() || '0', 8);
    const size = parseInt(head.subarray(124, 136).toString('ascii').trim() || '0', 8);
    const typeflag = head.subarray(156, 157).toString('ascii');
    offset += BLOCK;
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      entries.push({ name, mode, uid, gid, content: Buffer.from(archive.subarray(offset, offset + size)) });
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
