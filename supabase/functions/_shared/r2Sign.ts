// Minimal AWS SigV4 signer for Cloudflare R2 (S3-compatible).
// Uses only crypto.subtle — no npm deps, no cold-start bloat.
//
// R2 endpoint: https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>
// Service:  s3
// Region:   auto  (R2 accepts any region string; "auto" is idiomatic)

export type R2Creds = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type R2SignedRequest = {
  url: string;
  headers: Record<string, string>;
  method: string;
  body?: Uint8Array | null;
};

const enc = new TextEncoder();

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufToHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return new Uint8Array(sig);
}

function bufToHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, "0");
  return out;
}

function amzDate(d: Date) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

// URI-encode per S3 rules: each segment encoded, but "/" preserved.
function encodePath(path: string) {
  return path.split("/").map((seg) =>
    encodeURIComponent(seg).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  ).join("/");
}

export async function signR2Request(
  creds: R2Creds,
  method: "PUT" | "GET" | "DELETE" | "HEAD",
  key: string,
  body: Uint8Array | null,
  contentType?: string,
  extraHeaders?: Record<string, string>,
): Promise<R2SignedRequest> {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`;
  const rawPath = `/${creds.bucket}/${key.replace(/^\/+/, "")}`;
  const canonicalUri = encodePath(rawPath);
  const url = `https://${host}${canonicalUri}`;

  const now = new Date();
  const { amz, date } = amzDate(now);
  const region = "auto";
  const service = "s3";

  const payloadHash = body && body.length > 0 ? await sha256Hex(body) : await sha256Hex("");

  // Normalize all header keys to lowercase up-front so the canonical map is stable.
  const rawHeaders: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    ...(contentType ? { "content-type": contentType } : {}),
    ...(extraHeaders || {}),
  };
  const headers: Record<string, string> = {};
  for (const k of Object.keys(rawHeaders)) headers[k.toLowerCase()] = String(rawHeaders[k]).trim();

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    "", // no query
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(enc.encode("AWS4" + creds.secretAccessKey), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = bufToHex(await hmac(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    method,
    headers: { ...headers, Authorization: authorization },
    body: body || null,
  };
}

export async function r2Put(
  creds: R2Creds,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<Response> {
  const signed = await signR2Request(creds, "PUT", key, body, contentType);
  return fetch(signed.url, { method: "PUT", headers: signed.headers, body: signed.body! });
}

export async function r2Delete(creds: R2Creds, key: string): Promise<Response> {
  const signed = await signR2Request(creds, "DELETE", key, null);
  return fetch(signed.url, { method: "DELETE", headers: signed.headers });
}

// Slugify a filename for object keys.
export function slugifyFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
  const ext = (dot > 0 ? name.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
  return `${base}.${ext}`;
}
