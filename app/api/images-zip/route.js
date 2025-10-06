// File: app/api/images-zip/route.js
/* eslint-disable no-console */

// Force Node runtime and prevent static optimization
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------- helpers ---------- */
const sanitize = (s) =>
  String(s || "file")
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "file";

const inferExtFromHeadersOrUrl = (contentType, url) => {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("bmp")) return ".bmp";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("svg")) return ".svg";
  if (ct.includes("avif")) return ".avif";
  if (ct.includes("tiff")) return ".tiff";

  try {
    const clean = String(url || "").split("?")[0];
    const m = clean.match(/\.(png|jpg|jpeg|gif|bmp|webp|svg|avif|tiff)$/i);
    if (m) return m[0].toLowerCase();
  } catch {}
  return ".jpg";
};

const ensureUnique = (name, used) => {
  // name may already include extension; preserve it
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  let candidate = `${base}${ext}`;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}_${i}${ext}`;
    i += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
};

async function fetchAsBytes(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch ${url} failed with ${res.status}`);
  const ab = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(ab),
    contentType: res.headers.get("content-type") || "",
  };
}

/* ---------- GET (single file passthrough) ---------- */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) return new Response("Missing url", { status: 400 });

  try {
    const upstream = await fetch(url, { cache: "no-store" });
    if (!upstream.ok) {
      return new Response("Upstream error", { status: upstream.status });
    }
    const ct =
      upstream.headers.get("content-type") || "application/octet-stream";
    const ab = await upstream.arrayBuffer();
    return new Response(ab, {
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new Response("Fetch failed", { status: 502 });
  }
}

/* ---------- POST (zip many files) ---------- */
export async function POST(req) {
  try {
    // dynamic import (helps with production bundlers)
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();

    const body = await req.json().catch(() => ({}));
    // New format: [{ url, filename }]
    const files = Array.isArray(body?.files) ? body.files : null;
    // Legacy format: [{ imageUrl, itemCode/barcode/id, filename? }]
    const legacyItems = Array.isArray(body?.items) ? body.items : null;

    if (!files && !legacyItems) {
      return new Response("Bad request body", { status: 400 });
    }

    const used = new Set();

    if (files) {
      // -------- New path: each entry provides url, and optionally filename --------
      for (const f of files) {
        const url = f?.url;
        if (!url) continue;

        try {
          // Always fetch first so we can infer extension if needed
          const { bytes, contentType } = await fetchAsBytes(url);

          // Use provided filename if present; if missing extension, add it
          const providedRaw = f?.filename ?? f?.name ?? "";
          const providedSan = sanitize(providedRaw);
          const hasExt = /\.[^.]+$/.test(providedSan);

          const finalWithExt = hasExt
            ? providedSan // keep the extension that the client passed
            : sanitize(
                // add inferred extension when client didn't include one
                (providedSan || "image") +
                  inferExtFromHeadersOrUrl(contentType, url)
              );

          const filename = ensureUnique(finalWithExt, used);
          zip.file(filename, bytes);
        } catch {
          // skip bad entries and continue
        }
      }
    } else {
      // -------- Legacy path: infer filename from record fields --------
      for (const rec of legacyItems) {
        const url = rec?.imageUrl || rec?.url;
        if (!url) continue;

        try {
          const { bytes, contentType } = await fetchAsBytes(url);
          const ext = inferExtFromHeadersOrUrl(contentType, url);
          const baseCandidate =
            rec?.filename?.replace(/\.[^.]+$/, "") ||
            rec?.itemCode ||
            rec?.barcode ||
            rec?.id ||
            "image";

          const filename = ensureUnique(sanitize(baseCandidate) + ext, used);
          zip.file(filename, bytes);
        } catch {
          // skip this one; continue
        }
      }
    }

    const zipped = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const today = new Date().toISOString().slice(0, 10);
    return new Response(zipped, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename=product-images-${today}.zip`,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("images-zip error:", err);
    return new Response("Zip error", { status: 500 });
  }
}
