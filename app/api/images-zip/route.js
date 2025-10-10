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
  } catch (err) {
    console.error("Error inferring extension from URL:", err.message);
  }
  return ".jpg"; // Fallback
};

const ensureUnique = (name, used) => {
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

// 🔥 ENHANCED fetch with realistic browser headers, timeout, and redirect handling
async function fetchAsBytes(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        Referer: "https://www.google.com/",
        // ⚠️ NO Origin header — this is key for universal compatibility
      },
      redirect: "follow",
      compress: true,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    const ab = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(ab),
      contentType,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("Request timeout");
    }

    // Fallback: Use allorigins.win proxy
    console.warn(
      `Direct fetch failed for ${url}. Trying fallback proxy...`,
      err.message
    );
    try {
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(
        url
      )}`;
      const proxyRes = await fetch(proxyUrl, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
          Accept:
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          Connection: "keep-alive",
          Referer: "https://www.google.com/",
        },
        redirect: "follow",
        compress: true,
      });

      if (!proxyRes.ok) {
        throw new Error(`Proxy HTTP ${proxyRes.status} ${proxyRes.statusText}`);
      }

      const contentType = proxyRes.headers.get("content-type") || "";
      const ab = await proxyRes.arrayBuffer();
      return {
        bytes: new Uint8Array(ab),
        contentType,
      };
    } catch (proxyErr) {
      console.error(`Proxy also failed for ${url}:`, proxyErr.message);
      throw new Error(`Both direct and proxy fetch failed: ${err.message}`);
    }
  }
}

/* ---------- GET (single file passthrough) ---------- */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) return new Response("Missing url", { status: 400 });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const upstream = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: "https://www.google.com/",
      },
      redirect: "follow",
      compress: true,
    });

    clearTimeout(timeoutId);

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
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (err) {
    console.error("GET image proxy error:", err.message || err);
    return new Response("Fetch failed", { status: 502 });
  }
}

/* ---------- POST (zip many files) ---------- */
export async function POST(req) {
  try {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();

    const body = await req.json().catch(() => ({}));
    const files = Array.isArray(body?.files) ? body.files : null;
    const legacyItems = Array.isArray(body?.items) ? body.items : null;

    if (!files && !legacyItems) {
      return new Response("Bad request body", { status: 400 });
    }

    const used = new Set();

    if (files) {
      for (const f of files) {
        const url = f?.url;
        if (!url) continue;

        try {
          const { bytes, contentType } = await fetchAsBytes(url);

          const providedRaw = f?.filename ?? f?.name ?? "";
          const providedSan = sanitize(providedRaw);
          const hasExt = /\.[^.]+$/.test(providedSan);

          const finalWithExt = hasExt
            ? providedSan
            : sanitize(
                (providedSan || "image") +
                  inferExtFromHeadersOrUrl(contentType, url)
              );

          const filename = ensureUnique(finalWithExt, used);
          zip.file(filename, bytes);
        } catch (err) {
          console.error(
            `Failed to download image from ${url}:`,
            err.message || err
          );
        }
      }
    } else {
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
        } catch (err) {
          console.error(
            `Failed to download legacy image from ${url}:`,
            err.message || err
          );
        }
      }
    }

    if (used.size === 0) {
      return new Response("No valid images to download", { status: 400 });
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
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (err) {
    console.error("images-zip POST error:", err);
    return new Response("Zip generation failed", { status: 500 });
  }
}
