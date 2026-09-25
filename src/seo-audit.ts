/**
 * Deterministic SEO audit — score 0–100 with actionable issues.
 */

export type SeoIssue = {
  id: string;
  severity: "error" | "warn" | "info";
  pageSlug?: string;
  message: string;
  fixHint: string;
};

export type SeoAuditResult = {
  score: number;
  rank: "A" | "B" | "C" | "D" | "F";
  issues: SeoIssue[];
};

type PageRow = {
  slug: string;
  title: string | null;
  published: number;
  seo_json: string;
};

function rankFromScore(score: number): SeoAuditResult["rank"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

function parseSeo(raw: string): {
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  canonical?: string;
} {
  try {
    return JSON.parse(raw || "{}") as {
      metaTitle?: string;
      metaDescription?: string;
      ogImage?: string;
      canonical?: string;
    };
  } catch {
    return {};
  }
}

export function runSeoAudit(opts: {
  pages: PageRow[];
  siteSeo?: { metaTitle?: string; metaDescription?: string; ogImage?: string };
  imageAltsMissing?: number;
  hasRobots?: boolean;
  hasSitemap?: boolean;
}): SeoAuditResult {
  const issues: SeoIssue[] = [];
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();

  for (const page of opts.pages) {
    if (!page.published) continue;
    const seo = parseSeo(page.seo_json);
    const title = (seo.metaTitle || page.title || "").trim();
    const desc = (seo.metaDescription || "").trim();

    if (!title) {
      issues.push({
        id: `title-missing-${page.slug}`,
        severity: "error",
        pageSlug: page.slug,
        message: `Missing title on “${page.slug}”`,
        fixHint: "Set a unique meta title (30–60 characters).",
      });
    } else if (title.length < 20 || title.length > 70) {
      issues.push({
        id: `title-length-${page.slug}`,
        severity: "warn",
        pageSlug: page.slug,
        message: `Title length on “${page.slug}” is ${title.length} characters`,
        fixHint: "Aim for about 30–60 characters.",
      });
    }

    if (!desc) {
      issues.push({
        id: `desc-missing-${page.slug}`,
        severity: "error",
        pageSlug: page.slug,
        message: `Missing description on “${page.slug}”`,
        fixHint: "Add a meta description (70–160 characters).",
      });
    } else if (desc.length < 50 || desc.length > 170) {
      issues.push({
        id: `desc-length-${page.slug}`,
        severity: "warn",
        pageSlug: page.slug,
        message: `Description length on “${page.slug}” is ${desc.length} characters`,
        fixHint: "Aim for about 70–160 characters.",
      });
    }

    if (!seo.ogImage && !opts.siteSeo?.ogImage) {
      issues.push({
        id: `og-${page.slug}`,
        severity: "warn",
        pageSlug: page.slug,
        message: `No Open Graph image on “${page.slug}”`,
        fixHint: "Set ogImage on the page or a site-wide default.",
      });
    }

    const tKey = title.toLowerCase();
    if (tKey && titles.has(tKey)) {
      issues.push({
        id: `title-dup-${page.slug}`,
        severity: "error",
        pageSlug: page.slug,
        message: `Duplicate title shared with “${titles.get(tKey)}”`,
        fixHint: "Make each page title unique.",
      });
    } else if (tKey) {
      titles.set(tKey, page.slug);
    }

    const dKey = desc.toLowerCase();
    if (dKey && descriptions.has(dKey)) {
      issues.push({
        id: `desc-dup-${page.slug}`,
        severity: "warn",
        pageSlug: page.slug,
        message: `Duplicate description shared with “${descriptions.get(dKey)}”`,
        fixHint: "Write a unique description per page.",
      });
    } else if (dKey) {
      descriptions.set(dKey, page.slug);
    }
  }

  if ((opts.imageAltsMissing ?? 0) > 0) {
    issues.push({
      id: "alts",
      severity: "warn",
      message: `${opts.imageAltsMissing} image(s) missing alt text`,
      fixHint: "Add alt on Image blocks or bind fields that include alt.",
    });
  }

  if (opts.hasRobots === false) {
    issues.push({
      id: "robots",
      severity: "info",
      message: "robots.txt should be reachable",
      fixHint: "Public /robots.txt is served by the Worker.",
    });
  }
  if (opts.hasSitemap === false) {
    issues.push({
      id: "sitemap",
      severity: "info",
      message: "sitemap.xml should be reachable",
      fixHint: "Public /sitemap.xml is served by the Worker.",
    });
  }

  let score = 100;
  for (const issue of issues) {
    if (issue.severity === "error") score -= 12;
    else if (issue.severity === "warn") score -= 6;
    else score -= 2;
  }
  score = Math.max(0, Math.min(100, score));
  return { score, rank: rankFromScore(score), issues };
}
