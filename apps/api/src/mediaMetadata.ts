import { open } from "node:fs/promises";
import type { RecordingTime } from "@traffic/contracts";

export type ExtractedMediaMetadata = {
  width?: number;
  height?: number;
  durationMs?: number;
  recordingTime?: RecordingTime;
};

type Atom = { start: number; headerSize: number; size: number; type: string };
const MAX_TOP_LEVEL_ATOMS = 4096;
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const QUICKTIME_EPOCH_MS = Date.UTC(1904, 0, 1);

async function readAtomHeader(handle: Awaited<ReturnType<typeof open>>, position: number, limit: number): Promise<Atom | undefined> {
  if (position + 8 > limit) return undefined;
  const header = Buffer.alloc(16);
  const { bytesRead } = await handle.read(header, 0, 16, position);
  if (bytesRead < 8) return undefined;
  let size = header.readUInt32BE(0);
  const type = header.toString("ascii", 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (bytesRead < 16) return undefined;
    const large = header.readBigUInt64BE(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) size = limit - position;
  if (size < headerSize || position + size > limit) return undefined;
  return { start: position, headerSize, size, type };
}

function atomsInBuffer(buffer: Buffer, start: number, end: number): Atom[] {
  const result: Atom[] = [];
  let position = start;
  while (position + 8 <= end && result.length < MAX_TOP_LEVEL_ATOMS) {
    const size32 = buffer.readUInt32BE(position);
    const type = buffer.toString("ascii", position + 4, position + 8);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (position + 16 > end) break;
      const large = buffer.readBigUInt64BE(position + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      headerSize = 16;
    } else if (size32 === 0) size = end - position;
    if (size < headerSize || position + size > end) break;
    result.push({ start: position, headerSize, size, type });
    position += size;
  }
  return result;
}

const containerTypes = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "edts", "dinf"]);

function descendants(buffer: Buffer, start: number, end: number, depth = 0): Atom[] {
  if (depth > 8) return [];
  const atoms = atomsInBuffer(buffer, start, end);
  const all = [...atoms];
  for (const atom of atoms) {
    if (!containerTypes.has(atom.type) && atom.type !== "meta") continue;
    let childStart = atom.start + atom.headerSize;
    // The FullBox meta atom starts with version and flags before its child atoms.
    if (atom.type === "meta") childStart += 4;
    if (childStart <= atom.start + atom.size) all.push(...descendants(buffer, childStart, atom.start + atom.size, depth + 1));
  }
  return all;
}

function plausibleEmbeddedTimestamp(seconds: bigint): string | undefined {
  if (seconds <= 0n || seconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const milliseconds = QUICKTIME_EPOCH_MS + Number(seconds) * 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return undefined;
  const year = date.getUTCFullYear();
  if (!Number.isFinite(milliseconds) || year < 1970 || year > 2100) return undefined;
  return date.toISOString();
}

function extractMovieHeader(buffer: Buffer, atom: Atom, isoUtcTime: boolean): { recordingStartAt?: string; durationMs?: number } {
  const content = atom.start + atom.headerSize;
  if (content + 20 > atom.start + atom.size) return {};
  const version = buffer[content]!;
  if (version === 0) {
    const creation = BigInt(buffer.readUInt32BE(content + 4));
    const timescale = buffer.readUInt32BE(content + 12);
    const duration = buffer.readUInt32BE(content + 16);
    return {
      ...(isoUtcTime && plausibleEmbeddedTimestamp(creation) ? { recordingStartAt: plausibleEmbeddedTimestamp(creation)! } : {}),
      ...(timescale > 0 && duration !== 0xffffffff ? { durationMs: duration / timescale * 1000 } : {})
    };
  }
  if (version === 1 && content + 32 <= atom.start + atom.size) {
    const creation = buffer.readBigUInt64BE(content + 4);
    const timescale = buffer.readUInt32BE(content + 20);
    const duration = buffer.readBigUInt64BE(content + 24);
    return {
      ...(isoUtcTime && plausibleEmbeddedTimestamp(creation) ? { recordingStartAt: plausibleEmbeddedTimestamp(creation)! } : {}),
      ...(timescale > 0 && duration !== 0xffffffffffffffffn ? { durationMs: Number(duration) / timescale * 1000 } : {})
    };
  }
  return {};
}

function extractVideoDimensions(buffer: Buffer, allAtoms: Atom[]): { width?: number; height?: number } {
  const moov = allAtoms.find((atom) => atom.type === "moov");
  if (!moov) return {};
  const tracks = atomsInBuffer(buffer, moov.start + moov.headerSize, moov.start + moov.size).filter((atom) => atom.type === "trak");
  for (const track of tracks) {
    const trackAtoms = descendants(buffer, track.start + track.headerSize, track.start + track.size);
    const handler = trackAtoms.find((atom) => atom.type === "hdlr");
    if (!handler) continue;
    const handlerContent = handler.start + handler.headerSize;
    if (handlerContent + 12 > buffer.length || buffer.toString("ascii", handlerContent + 8, handlerContent + 12) !== "vide") continue;
    const tkhd = trackAtoms.find((atom) => atom.type === "tkhd");
    if (!tkhd || tkhd.start + tkhd.size - 8 < 0) continue;
    const widthFixed = buffer.readUInt32BE(tkhd.start + tkhd.size - 8);
    const heightFixed = buffer.readUInt32BE(tkhd.start + tkhd.size - 4);
    const width = Math.floor(widthFixed / 65536);
    const height = Math.floor(heightFixed / 65536);
    if (width > 0 && height > 0) return { width, height };
  }
  return {};
}

/** Reads only MP4/MOV atom headers and a capped moov metadata atom; never decodes frames. */
export async function inspectMediaMetadata(filePath: string): Promise<ExtractedMediaMetadata> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const { size: fileSize } = await handle.stat();
    let position = 0;
    let moov: Atom | undefined;
    let ftypBrands: string[] = [];
    for (let count = 0; count < MAX_TOP_LEVEL_ATOMS && position + 8 <= fileSize; count++) {
      const atom = await readAtomHeader(handle, position, fileSize);
      if (!atom) break;
      if (atom.type === "ftyp" && atom.size <= 4096) {
        const ftyp = Buffer.alloc(atom.size);
        const { bytesRead: ftypBytes } = await handle.read(ftyp, 0, ftyp.length, atom.start);
        if (ftypBytes === ftyp.length && ftyp.length >= atom.headerSize + 8) {
          ftypBrands = [ftyp.toString("ascii", atom.headerSize, atom.headerSize + 4)];
          for (let offset = atom.headerSize + 8; offset + 4 <= ftyp.length; offset += 4) ftypBrands.push(ftyp.toString("ascii", offset, offset + 4));
        }
      }
      if (atom.type === "moov") { moov = atom; break; }
      position += atom.size;
    }
    if (!moov || moov.size > MAX_MOOV_BYTES) return {};
    const buffer = Buffer.alloc(moov.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, moov.start);
    if (bytesRead !== buffer.length) return {};
    const topAtoms = atomsInBuffer(buffer, 0, buffer.length);
    const moovAtom = topAtoms.find((atom) => atom.type === "moov");
    const moovChildren = moovAtom ? atomsInBuffer(buffer, moovAtom.start + moovAtom.headerSize, moovAtom.start + moovAtom.size) : [];
    const allAtoms = descendants(buffer, 0, buffer.length);
    const movieHeader = moovChildren.find((atom) => atom.type === "mvhd");
    const isoUtcBrands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash"]);
    const isoUtcTime = ftypBrands.some((brand) => isoUtcBrands.has(brand)) && !ftypBrands.includes("qt  ");
    const movieMetadata = movieHeader ? extractMovieHeader(buffer, movieHeader, isoUtcTime) : {};
    const dimensions = extractVideoDimensions(buffer, allAtoms);
    const timestamp = movieMetadata.recordingStartAt;
    return {
      ...dimensions,
      ...(movieMetadata.durationMs !== undefined && Number.isFinite(movieMetadata.durationMs) ? { durationMs: movieMetadata.durationMs } : {}),
      ...(timestamp ? {
        recordingTime: {
          effectiveStartAt: timestamp,
          provenance: "embedded_metadata",
          embeddedStartAt: timestamp,
          embeddedField: "mvhd_creation_time"
        }
      } : {})
    };
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function canonicalizeOffsetDateTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const localCalendar = new Date(0);
  localCalendar.setUTCFullYear(year!, month! - 1, day!);
  localCalendar.setUTCHours(hour!, minute!, second!, 0);
  if (localCalendar.getUTCFullYear() !== year || localCalendar.getUTCMonth() !== month! - 1 || localCalendar.getUTCDate() !== day || hour! > 23 || minute! > 59 || second! > 59) return undefined;
  if (offsetHourText !== undefined) {
    const offsetHours = Number(offsetHourText);
    const offsetMinutes = Number(offsetMinuteText);
    if (offsetHours > 14 || offsetMinutes > 59 || offsetHours === 14 && offsetMinutes !== 0) return undefined;
    if (match[8] === "-" && offsetHours === 0 && offsetMinutes === 0) return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}
