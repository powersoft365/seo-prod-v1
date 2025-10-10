/* eslint-disable no-console */

// Force Node runtime and prevent static optimization
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel/Node time hints (helps avoid early termination on larger zips)
export const maxDuration = 60; // seconds

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

// Build a set of robust proxy fallbacks for when origins block Vercel IPs
function buildProxyUrls(rawUrl) {
  const u = String(rawUrl);
  let hostPath = u.replace(/^https?:\/\//i, ""); // used by some proxies
  // images.weserv.nl requires no protocol and no leading slash
  hostPath = hostPath.replace(/^\/+/, "");

  return [
    // AllOrigins (raw passthrough)
    `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    // images.weserv.nl (very reliable for images)
    `https://images.weserv.nl/?url=${encodeURIComponent(hostPath)}`,
    // Codetabs proxy
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    // isomorphic-git simple CORS proxy
    `https://cors.isomorphic-git.org/${u}`,
    // Thingproxy
    `https://thingproxy.freeboard.io/fetch/${u}`,
  ];
}

// Single attempt fetch with browser-like headers
async function fetchBytes(url, signal) {
  const res = await fetch(url, {
    cache: "no-store",
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      // Intentionally omit Origin; many image CDNs reject unexpected origins
      Referer: "https://www.google.com/",
    },
    redirect: "follow",
    // Node fetch ignores Accept-Encoding; leave compress on so gzip is handled
    compress: true,
  });

  const contentType = res.headers.get("content-type") || "";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} ${res.statusText} ${
        text ? `- ${text.slice(0, 140)}` : ""
      }`
    );
  }
  const ab = await res.arrayBuffer();
  return { bytes: new Uint8Array(ab), contentType };
}

// 🔥 Unified fetch with realistic headers, timeout, redirect handling, and MULTI-PROXY fallbacks
async function fetchAsBytes(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    // 1) Try origin directly
    return await fetchBytes(url, controller.signal);
  } catch (originErr) {
    console.warn(`Direct fetch failed for ${url}:`, originErr.message);
    // 2) Try a sequence of neutral proxies
    const proxies = buildProxyUrls(url);
    for (const p of proxies) {
      try {
        console.warn(`Trying proxy: ${p}`);
        const result = await fetchBytes(p, controller.signal);
        clearTimeout(timeoutId);
        return result;
      } catch (proxyErr) {
        console.warn(`Proxy failed: ${p} -> ${proxyErr.message}`);
      }
    }
    clearTimeout(timeoutId);
    throw new Error(
      `All fetch strategies failed for ${url}. Last error: ${originErr.message}`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------- GET (single file passthrough proxy) ---------- */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) return new Response("Missing url", { status: 400 });

  try {
    // Use the same resilient pipeline as POST to avoid 403s in production
    const { bytes, contentType } = await fetchAsBytes(url);

    return new Response(bytes, {
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
        // Wide-open CORS for browser usage
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (err) {
    console.error("GET image proxy error:", err.message || err);
    return new Response("Fetch failed", {
      status: 502,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
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
      return new Response("Bad request body", {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
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
      return new Response("No valid images to download", {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
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
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (err) {
    console.error("images-zip POST error:", err);
    return new Response("Zip generation failed", {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
}

/* ---------- OPTIONS (CORS preflight) ---------- */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
