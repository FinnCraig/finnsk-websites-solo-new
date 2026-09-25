/** Public SEO helpers — SSR meta shell, robots, sitemap. */

export type PublicSeoMeta = {
  documentTitle: string;
  description?: string;
  canonical?: string;
  ogImage?: string;
  ogTitle?: string;
  ogDescription?: string;
  robots?: string;
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildPublicHtmlShell(opts: {
  meta: PublicSeoMeta;
  spaAssetPrefix?: string;
  bootstrapJson?: string;
  customHeadHtml?: string;
  customCss?: string;
}): string {
  const m = opts.meta;
  const title = esc(m.documentTitle || "Site");
  const desc = m.description ? esc(m.description) : "";
  const canonical = m.canonical ? esc(m.canonical) : "";
  const ogImage = m.ogImage ? esc(m.ogImage) : "";
  const ogTitle = esc(m.ogTitle || m.documentTitle || "Site");
  const ogDesc = esc(m.ogDescription || m.description || "");
  const robots = esc(m.robots || "index,follow");
  const jsonLd = m.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(m.jsonLd).replace(/</g, "\\u003c")}</script>`
    : "";
  const bootstrap = opts.bootstrapJson
    ? `<script type="application/json" id="fk-public-bootstrap">${opts.bootstrapJson.replace(/</g, "\\u003c")}</script>`
    : "";
  const customCss = opts.customCss
    ? `<style id="fk-custom-css">${opts.customCss.replace(/<\/style/gi, "")}</style>`
    : "";
  const customHead = opts.customHeadHtml || "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
${desc ? `<meta name="description" content="${desc}"/>` : ""}
<meta name="robots" content="${robots}"/>
${canonical ? `<link rel="canonical" href="${canonical}"/>` : ""}
<meta property="og:type" content="website"/>
<meta property="og:title" content="${ogTitle}"/>
${ogDesc ? `<meta property="og:description" content="${ogDesc}"/>` : ""}
${ogImage ? `<meta property="og:image" content="${ogImage}"/>` : ""}
${canonical ? `<meta property="og:url" content="${canonical}"/>` : ""}
<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}"/>
<meta name="twitter:title" content="${ogTitle}"/>
${ogDesc ? `<meta name="twitter:description" content="${ogDesc}"/>` : ""}
${ogImage ? `<meta name="twitter:image" content="${ogImage}"/>` : ""}
${jsonLd}
${customCss}
${customHead}
${bootstrap}
<link rel="stylesheet" href="/assets/index.css" onerror="this.remove()"/>
</head>
<body>
<div id="root"></div>
<script type="module" src="/assets/index.js"></script>
</body>
</html>`;
}

export function buildRobotsTxt(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `User-agent: *\nAllow: /\nDisallow: /edit\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`;
}

export function buildSitemapXml(
  origin: string,
  urls: Array<{ loc: string; lastmod?: string }>
): string {
  const base = origin.replace(/\/$/, "");
  const body = urls
    .map((u) => {
      const loc = u.loc.startsWith("http") ? u.loc : `${base}${u.loc.startsWith("/") ? "" : "/"}${u.loc}`;
      return `<url><loc>${esc(loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ""}</url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}
