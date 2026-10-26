import { mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { extname, join } from "path";
import { randomBytes } from "crypto";
import { Readable } from "stream";

// Types WhatsApp accepts for bot-sent media, plus a few common extras.
const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip",
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
};
const EXT_MIME = { jpeg: "image/jpeg", ...Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m])) };

const ID_RE = /^media_[\w-]+$/;
const FILE_RE = /^(media_[\w-]+)\.(.+)$/;

// Drops parameters (`; codecs=opus`) and anything that isn't a plain type/subtype,
// since the value ends up in a Content-Type header.
function normalizeMime(mime) {
  const type = String(mime || "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "";
}

// A generic octet-stream from the sender is less informative than the extension.
function resolveMime(declared, fileName) {
  const mime = normalizeMime(declared);
  if (mime && mime !== "application/octet-stream") return mime;
  return EXT_MIME[extname(fileName).slice(1).toLowerCase()] || mime || "application/octet-stream";
}

function sanitizeFileName(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const ext = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length);
  return (stem.slice(0, 100) + ext.slice(0, 16)) || "file";
}

/**
 * Local store for files the bot sends (uploaded to /media or fetched from a
 * link). Files sit flat in one directory, named `<mediaId>.<original name>`;
 * the id is everything before the first dot, so the index can be rebuilt from
 * the directory listing and nothing else needs to be persisted.
 */
export class MediaStore {
  constructor(dir) {
    this.dir = dir;
    this.index = new Map();
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir)) {
      const info = this._describe(file);
      if (info) this.index.set(info.id, info);
    }
  }

  _describe(file) {
    const match = FILE_RE.exec(file);
    if (!match) return null;
    let stat;
    try { stat = statSync(join(this.dir, file)); } catch { return null; }
    if (!stat.isFile()) return null;
    return {
      id: match[1],
      fileName: match[2],
      file,
      size: stat.size,
      mimeType: resolveMime("", match[2]),
    };
  }

  newId() {
    let id;
    do { id = `media_${randomBytes(5).toString("hex")}`; } while (this.index.has(id));
    return id;
  }

  /**
   * Write a file to disk. `id` is supplied when the emulator already issued
   * one (the bot holds it); otherwise a new one is generated.
   */
  save({ id = this.newId(), buffer, fileName, mimeType }) {
    if (!ID_RE.test(id)) throw new Error(`invalid media id: ${id}`);
    let name = sanitizeFileName(fileName);
    const mime = resolveMime(mimeType, name);
    if (!extname(name) && MIME_EXT[mime]) name += `.${MIME_EXT[mime]}`;
    const file = `${id}.${name}`;
    writeFileSync(join(this.dir, file), buffer);
    const info = { id, fileName: name, file, size: buffer.length, mimeType: mime };
    this.index.set(id, info);
    return info;
  }

  get(id) {
    return this.index.get(id) || null;
  }
}

/** Fields of a stored file that belong on a UI message. */
export function describeMedia(info) {
  return { id: info.id, fileName: info.fileName, mimeType: info.mimeType, size: info.size };
}

/**
 * Parse a multipart/form-data request body (the Cloud API media upload) with
 * the built-in Request.formData(), so no extra dependency is needed. The body
 * is buffered in memory; anything past `maxBytes` aborts the read.
 */
export async function readMultipart(req, maxBytes) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    throw new Error("Expected a multipart/form-data body");
  }
  // Headroom for the multipart framing and the non-file fields.
  const limit = maxBytes + 64 * 1024;
  if (Number(req.headers["content-length"]) > limit) throw new RangeError("upload too large");

  let seen = 0;
  const body = Readable.toWeb(req).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(new RangeError("upload too large"));
        else controller.enqueue(chunk);
      },
    })
  );
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
    duplex: "half",
  }).formData();
}

function dispositionFileName(header) {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].trim()); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/**
 * Fetch a media `link` the way WhatsApp would. Returns the bytes plus the
 * content type and a file name taken from Content-Disposition or the URL.
 */
export async function downloadLink(link, { maxBytes, timeoutMs }) {
  const url = new URL(link);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol ${url.protocol}`);
  }
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const chunks = [];
  let total = 0;
  for await (const chunk of resp.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`file exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
    chunks.push(chunk);
  }

  let urlName = "";
  try { urlName = decodeURIComponent(url.pathname.split("/").pop()); } catch { /* keep empty */ }
  return {
    buffer: Buffer.concat(chunks),
    mimeType: resp.headers.get("content-type"),
    fileName: dispositionFileName(resp.headers.get("content-disposition")) || urlName,
  };
}
