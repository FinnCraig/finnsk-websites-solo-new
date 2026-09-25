import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { cors } from "hono/cors";

import {
  SOLO_DEFAULT_FOOTER,
  SOLO_DEFAULT_NAVBAR,
  SOLO_DEFAULT_SITE_ID,
  SOLO_SCHEMA_SQL,
} from "./schema";
import { hashPassword, verifyPassword, signSession, verifySession } from "./auth";
import { blankHomeDocumentJson } from "./seed-document";
import type { SoloEnv } from "./env";
import {
  disableModule,
  enableModule,
  forEachModuleWithRoutes,
  isModuleEnabled,
  listSiteModules,
} from "./modules";
import { handleMcpJsonRpc, type McpDocStore } from "./mcp";
import { normalizeOps, runOps, summarizeDiff } from "./ops";
import { composeOpsWithGemini, previewCompose, type AiSettings } from "./ai";
import { runDesignAgentTurn, type AgentMessage } from "./agent";
import { MOTION_COOKBOOK } from "./cookbook";
import { listIconCollections, searchIcons } from "./iconify";
import { SCENE3D_COOKBOOK } from "./scene3d-cookbook";
import {
  COLLECTION_PRESETS,
  createCollection,
  deleteCollection,
  deleteItem,
  getCollection,
  getItem,
  listCollections,
  listItems,
  parseFields,
  updateCollection,
  upsertItem,
} from "./collections";
import { runSeoAudit } from "./seo-audit";
import { buildRobotsTxt, buildSitemapXml } from "./public-seo";
import {
  applyItemToDocument,
  collectionIndexDocument,
  collectionItemDocument,
  expandCollectionIndex,
  fallbackItemDocument,
  itemDescription,
  itemDisplayName,
  itemImage,
  type PageDoc,
} from "./collection-render";

export type { SoloEnv } from "./env";

const SITE_ID = SOLO_DEFAULT_SITE_ID;
const SESSION_COOKIE = "finnsk_solo_session";

type Variables = { userId?: string };

const app = new Hono<{ Bindings: SoloEnv; Variables: Variables }>();

function sessionCookieOpts(c: Context<{ Bindings: SoloEnv; Variables: Variables }>) {
  const url = new URL(c.req.url);
  const secure = url.protocol === "https:";
  return {
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}

function requireSessionSecret(c: Context<{ Bindings: SoloEnv; Variables: Variables }>): true | Response {
  if (!c.env.SESSION_SECRET || !String(c.env.SESSION_SECRET).trim()) {
    return c.json(
      {
        error:
          "SESSION_SECRET is not set. Copy packages/workers/worker-solo/.dev.vars.example to .dev.vars for local, or set the secret via wrangler.",
        code: "MISSING_SESSION_SECRET",
      },
      503
    );
  }
  return true;
}

app.use(
  "/api/*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
  })
);

async function ensureSchema(db: D1Database): Promise<void> {
  const statements = SOLO_SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}

/** No-op kept for call sites that previously seeded lab demos. */
async function ensureDemoPages(_db: D1Database): Promise<void> {
  return;
}

async function isConfigured(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM solo_meta WHERE key = 'configured'`)
    .first<{ value: string }>();
  return row?.value === "1";
}

app.get("/api/health", (c) =>
  c.json({ ok: true, product: "finnsk-websites-solo", siteId: SITE_ID })
);

app.get("/api/setup/status", async (c) => {
  await ensureSchema(c.env.SITE_DB);
  const configured = await isConfigured(c.env.SITE_DB);
  return c.json({ configured });
});

app.post("/api/setup", async (c) => {
  const secretOk = requireSessionSecret(c);
  if (secretOk !== true) return secretOk;
  await ensureSchema(c.env.SITE_DB);
  if (await isConfigured(c.env.SITE_DB)) {
    return c.json({ error: "Already configured" }, 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    password?: string;
    siteName?: string;
    email?: string;
  };
  const password = String(body.password ?? "");
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  const siteName = String(body.siteName ?? "My Site").trim() || "My Site";
  const email = String(body.email ?? "owner@local").trim() || "owner@local";

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const pageId = crypto.randomUUID();
  const blockId = crypto.randomUUID();
  const navbar = { ...SOLO_DEFAULT_NAVBAR, brand: siteName };
  const footer = { ...SOLO_DEFAULT_FOOTER, copyright: `© ${siteName}` };
  const docJson = blankHomeDocumentJson();

  await c.env.SITE_DB.batch([
    c.env.SITE_DB.prepare(
      `INSERT INTO solo_users (id, email, password_hash) VALUES (?, ?, ?)`
    ).bind(userId, email, passwordHash),
    c.env.SITE_DB.prepare(
      `INSERT INTO site_settings (site_id, settings_json) VALUES (?, ?)`
    ).bind(SITE_ID, JSON.stringify({ navbar, footer })),
    c.env.SITE_DB.prepare(
      `INSERT INTO pages (id, site_id, slug, title, nav_order, published, nav_title, seo_json)
       VALUES (?, ?, 'home', 'Home', 0, 1, NULL, '{}')`
    ).bind(pageId, SITE_ID),
    c.env.SITE_DB.prepare(
      `INSERT INTO page_blocks (id, site_id, page_slug, component_type, props_json, order_index)
       VALUES (?, ?, 'home', 'ProposalDocument', ?, 0)`
    ).bind(blockId, SITE_ID, docJson),
    c.env.SITE_DB.prepare(
      `INSERT INTO solo_meta (key, value) VALUES ('configured', '1')`
    ),
    c.env.SITE_DB.prepare(
      `INSERT INTO solo_meta (key, value) VALUES ('site_name', ?)`
    ).bind(siteName),
  ]);

  const token = await signSession(c.env.SESSION_SECRET, userId);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOpts(c));

  return c.json({ ok: true, siteId: SITE_ID });
});

app.post("/api/auth/login", async (c) => {
  const secretOk = requireSessionSecret(c);
  if (secretOk !== true) return secretOk;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    password?: string;
    email?: string;
  };
  const password = String(body.password ?? "");
  const email = String(body.email ?? "owner@local").trim();

  const user = await c.env.SITE_DB.prepare(
    `SELECT id, password_hash FROM solo_users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; password_hash: string }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const token = await signSession(c.env.SESSION_SECRET, user.id);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOpts(c));
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.post("/api/auth/password", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    currentPassword?: string;
    newPassword?: string;
  };
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  const user = await c.env.SITE_DB.prepare(
    `SELECT id, password_hash FROM solo_users WHERE id = ?`
  )
    .bind(auth.userId)
    .first<{ id: string; password_hash: string }>();
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    return c.json({ error: "Current password is wrong" }, 401);
  }
  const passwordHash = await hashPassword(newPassword);
  await c.env.SITE_DB.prepare(`UPDATE solo_users SET password_hash = ? WHERE id = ?`)
    .bind(passwordHash, user.id)
    .run();
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !c.env.SESSION_SECRET) return c.json({ authenticated: false });
  try {
    const { sub } = await verifySession(c.env.SESSION_SECRET, token);
    return c.json({ authenticated: true, userId: sub });
  } catch {
    return c.json({ authenticated: false });
  }
});

async function requireUser(
  c: Context<{ Bindings: SoloEnv; Variables: Variables }>
): Promise<{ userId: string } | Response> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !c.env.SESSION_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  try {
    const { sub } = await verifySession(c.env.SESSION_SECRET, token);
    return { userId: sub };
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
}

type PublicSeoBag = {
  pageKind?: string;
  collectionId?: string;
  collectionSlug?: string;
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  canonical?: string;
  robots?: string;
};

function parseSeoBag(raw: string | null | undefined): PublicSeoBag {
  try {
    return JSON.parse(raw || "{}") as PublicSeoBag;
  } catch {
    return {};
  }
}

function parseItemData(raw: string | null | undefined): Record<string, unknown> {
  try {
    const data = JSON.parse(raw || "{}") as unknown;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseDoc(raw: string | null | undefined): PageDoc {
  try {
    const doc = JSON.parse(raw || "{}") as PageDoc;
    return doc && typeof doc === "object" ? doc : {};
  } catch {
    return {};
  }
}

/** Settings safe to ship to visitors — never API keys or MCP tokens. */
function settingsForPublic(settings: Record<string, unknown>): Record<string, unknown> {
  const seo = (settings.seo || {}) as Record<string, unknown>;
  return {
    navbar: settings.navbar || null,
    footer: settings.footer || null,
    customCss: typeof settings.customCss === "string" ? settings.customCss : "",
    seo: {
      metaTitle: seo.metaTitle,
      metaDescription: seo.metaDescription,
      ogImage: seo.ogImage,
      favicon: seo.favicon,
      themeColor: seo.themeColor,
    },
  };
}

async function loadSettingsRaw(db: D1Database): Promise<Record<string, unknown>> {
  const settingsRow = await db
    .prepare(`SELECT settings_json FROM site_settings WHERE site_id = ?`)
    .bind(SITE_ID)
    .first<{ settings_json: string }>();
  try {
    return JSON.parse(settingsRow?.settings_json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function publishedNavPages(db: D1Database) {
  const navPages = await db
    .prepare(
      `SELECT slug, title, nav_title, seo_json FROM pages WHERE site_id = ? AND published = 1 ORDER BY nav_order ASC, title ASC`
    )
    .bind(SITE_ID)
    .all<{ slug: string; title: string | null; nav_title: string | null; seo_json: string }>();
  return (navPages.results ?? [])
    .filter((p) => parseSeoBag(p.seo_json).pageKind !== "collection-item")
    .map((p) => ({
      slug: p.slug,
      title: (p.nav_title || p.title || p.slug).trim(),
    }));
}

async function findCollectionPage(
  db: D1Database,
  kind: "collection-index" | "collection-item",
  collectionId: string
) {
  const rows = await db
    .prepare(`SELECT slug, title, seo_json, published FROM pages WHERE site_id = ?`)
    .bind(SITE_ID)
    .all<{ slug: string; title: string | null; seo_json: string; published: number }>();
  return (
    (rows.results ?? []).find((p) => {
      const seo = parseSeoBag(p.seo_json);
      return seo.pageKind === kind && seo.collectionId === collectionId;
    }) ?? null
  );
}

async function documentForSlug(db: D1Database, pageSlug: string): Promise<PageDoc | null> {
  const block = await db
    .prepare(
      `SELECT props_json FROM page_blocks
       WHERE site_id = ? AND page_slug = ? AND component_type = 'ProposalDocument'
       ORDER BY order_index ASC LIMIT 1`
    )
    .bind(SITE_ID, pageSlug)
    .first<{ props_json: string }>();
  if (!block) return null;
  return parseDoc(block.props_json);
}

type PublicPayload = {
  blocks: Array<{
    id: string;
    site_id: string;
    page_slug: string;
    component_type: string;
    props_json: string;
    order_index: number;
  }>;
  settings: Record<string, unknown>;
  pages: Array<{ slug: string; title: string }>;
  currentSlug: string;
  pageMeta?: Record<string, unknown>;
};

async function buildPublicPayload(
  db: D1Database,
  pageSlugRaw: string
): Promise<PublicPayload | { error: string; status: 404 }> {
  const pageSlug = pageSlugRaw || "home";
  const settings = await loadSettingsRaw(db);
  const pages = await publishedNavPages(db);
  const siteSeo = (settings.seo || {}) as PublicSeoBag;

  const finish = (
    doc: PageDoc,
    currentSlug: string,
    meta: { title: string; description?: string; ogImage?: string; robots?: string }
  ): PublicPayload => {
    const pageMeta: Record<string, unknown> = {};
    if (meta.title) pageMeta.documentTitle = meta.title;
    if (meta.description) pageMeta.description = meta.description;
    if (meta.ogImage) pageMeta.ogImage = meta.ogImage;
    if (meta.robots) pageMeta.robots = meta.robots;
    return {
      blocks: [
        {
          id: "public-doc",
          site_id: SITE_ID,
          page_slug: currentSlug,
          component_type: "ProposalDocument",
          props_json: JSON.stringify(doc),
          order_index: 0,
        },
      ],
      settings: settingsForPublic(settings),
      pages,
      currentSlug,
      ...(Object.keys(pageMeta).length ? { pageMeta } : {}),
    };
  };

  if (pageSlug.includes("/")) {
    const [collSlug, itemSlug, extra] = pageSlug.split("/");
    if (!collSlug || !itemSlug || extra) return { error: "Page not found", status: 404 };
    const coll = await getCollection(db, collSlug);
    if (!coll) return { error: "Page not found", status: 404 };
    const item = await getItem(db, coll.id, itemSlug);
    if (!item || item.status !== "published") return { error: "Page not found", status: 404 };
    const data = parseItemData(item.data_json);
    const href = `/${coll.slug}/${item.slug}`;
    const template = await findCollectionPage(db, "collection-item", coll.id);
    const base = template ? await documentForSlug(db, template.slug) : null;
    const doc = base
      ? applyItemToDocument(base, data, href)
      : fallbackItemDocument(data, href);
    const title =
      (template ? parseSeoBag(template.seo_json).metaTitle : "") ||
      itemDisplayName(data, item.slug);
    const description = itemDescription(data) || siteSeo.metaDescription || "";
    const og = itemImage(data) || siteSeo.ogImage || "";
    return finish(doc, `${coll.slug}/${item.slug}`, {
      title,
      description,
      ogImage: og,
    });
  }

  const page = await db
    .prepare(
      `SELECT slug, title, published, nav_title, seo_json FROM pages WHERE site_id = ? AND slug = ?`
    )
    .bind(SITE_ID, pageSlug)
    .first<{
      slug: string;
      title: string | null;
      published: number;
      nav_title: string | null;
      seo_json: string;
    }>();

  if (!page || !page.published) return { error: "Page not found", status: 404 };
  const seo = parseSeoBag(page.seo_json);
  let doc = (await documentForSlug(db, page.slug)) || {};
  if (seo.pageKind === "collection-index" && seo.collectionId) {
    const coll = await getCollection(db, seo.collectionId);
    if (coll) {
      const items = await listItems(db, coll.id, { publishedOnly: true });
      doc = expandCollectionIndex(
        doc,
        items.map((item) => ({ slug: item.slug, data: parseItemData(item.data_json) })),
        coll.slug
      );
    }
  } else if (seo.pageKind === "collection-item" && seo.collectionId) {
    const coll = await getCollection(db, seo.collectionId);
    if (coll) {
      const items = await listItems(db, coll.id, { publishedOnly: true });
      const sample = items[0];
      if (sample) {
        doc = applyItemToDocument(
          doc,
          parseItemData(sample.data_json),
          `/${coll.slug}/${sample.slug}`
        );
      }
    }
  }
  const title = (seo.metaTitle || page.title || siteSeo.metaTitle || page.slug).trim();
  const description = (seo.metaDescription || siteSeo.metaDescription || "").trim();
  const og = (seo.ogImage || siteSeo.ogImage || "").trim();
  return finish(doc, page.slug, {
    title,
    description,
    ogImage: og,
    robots: seo.robots,
  });
}

/** Public page JSON — same shape as tenant-api `/r/:tenantId/:pageSlug/data`. */
app.get("/api/public/:pageSlug/data", async (c) => {
  await ensureSchema(c.env.SITE_DB);
  const pageSlug = c.req.param("pageSlug") || "home";
  const payload = await buildPublicPayload(c.env.SITE_DB, pageSlug);
  if ("error" in payload) return c.json({ error: payload.error, code: "PAGE_NOT_FOUND" }, payload.status);
  return c.json(payload, 200, {
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
  });
});

app.get("/api/pages", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  await ensureDemoPages(c.env.SITE_DB);
  const rows = await c.env.SITE_DB.prepare(
    `SELECT id, slug, title, published, nav_order, nav_title, seo_json FROM pages WHERE site_id = ? ORDER BY nav_order ASC`
  )
    .bind(SITE_ID)
    .all<{
      id: string;
      slug: string;
      title: string | null;
      published: number;
      nav_order: number;
      nav_title: string | null;
      seo_json: string;
    }>();
  const pages = (rows.results ?? []).map((p) => {
    const seo = parseSeoBag(p.seo_json);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      published: p.published,
      nav_order: p.nav_order,
      nav_title: p.nav_title,
      pageKind: seo.pageKind || "static",
      collectionId: seo.collectionId || null,
      collectionSlug: seo.collectionSlug || null,
    };
  });
  return c.json({ pages });
});

app.get("/api/pages/:slug/document", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const slug = c.req.param("slug");
  const page = await c.env.SITE_DB.prepare(
    `SELECT id, slug, title, published, nav_title, seo_json FROM pages WHERE site_id = ? AND slug = ?`
  )
    .bind(SITE_ID, slug)
    .first();
  if (!page) return c.json({ error: "Not found" }, 404);

  const block = await c.env.SITE_DB.prepare(
    `SELECT id, props_json FROM page_blocks
     WHERE site_id = ? AND page_slug = ? AND component_type = 'ProposalDocument'
     ORDER BY order_index ASC LIMIT 1`
  )
    .bind(SITE_ID, slug)
    .first<{ id: string; props_json: string }>();

  let document: unknown = {};
  try {
    document = JSON.parse(block?.props_json || "{}");
  } catch {
    document = {};
  }

  let seo: Record<string, unknown> = {};
  try {
    seo = JSON.parse(String((page as { seo_json?: string }).seo_json || "{}")) as Record<
      string,
      unknown
    >;
  } catch {
    seo = {};
  }

  return c.json({ page: { ...page, seo }, blockId: block?.id ?? null, document });
});

app.put("/api/pages/:slug/document", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const slug = c.req.param("slug");
  const body = (await c.req.json().catch(() => ({}))) as { document?: unknown };
  if (body.document == null) return c.json({ error: "document required" }, 400);

  const page = await c.env.SITE_DB.prepare(
    `SELECT id FROM pages WHERE site_id = ? AND slug = ?`
  )
    .bind(SITE_ID, slug)
    .first();
  if (!page) return c.json({ error: "Not found" }, 404);

  const propsJson = JSON.stringify(body.document);
  const existing = await c.env.SITE_DB.prepare(
    `SELECT id FROM page_blocks
     WHERE site_id = ? AND page_slug = ? AND component_type = 'ProposalDocument' LIMIT 1`
  )
    .bind(SITE_ID, slug)
    .first<{ id: string }>();

  if (existing) {
    await c.env.SITE_DB.prepare(`UPDATE page_blocks SET props_json = ? WHERE id = ?`)
      .bind(propsJson, existing.id)
      .run();
  } else {
    await c.env.SITE_DB.prepare(
      `INSERT INTO page_blocks (id, site_id, page_slug, component_type, props_json, order_index)
       VALUES (?, ?, ?, 'ProposalDocument', ?, 0)`
    )
      .bind(crypto.randomUUID(), SITE_ID, slug, propsJson)
      .run();
  }

  await c.env.SITE_DB.prepare(
    `UPDATE pages SET html_cache_revision = html_cache_revision + 1 WHERE site_id = ? AND slug = ?`
  )
    .bind(SITE_ID, slug)
    .run();

  return c.json({ ok: true });
});

app.post("/api/pages", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: string;
    title?: string;
    seo_json?: Record<string, unknown>;
    document?: unknown;
  };
  const slug = String(body.slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const title = String(body.title ?? slug).trim() || slug;
  const seoJson = JSON.stringify(body.seo_json && typeof body.seo_json === "object" ? body.seo_json : {});
  const docJson =
    body.document && typeof body.document === "object"
      ? JSON.stringify(body.document)
      : blankHomeDocumentJson();

  try {
    await c.env.SITE_DB.batch([
      c.env.SITE_DB.prepare(
        `INSERT INTO pages (id, site_id, slug, title, nav_order, published, seo_json)
         VALUES (?, ?, ?, ?, 100, 1, ?)`
      ).bind(crypto.randomUUID(), SITE_ID, slug, title, seoJson),
      c.env.SITE_DB.prepare(
        `INSERT INTO page_blocks (id, site_id, page_slug, component_type, props_json, order_index)
         VALUES (?, ?, ?, 'ProposalDocument', ?, 0)`
      ).bind(crypto.randomUUID(), SITE_ID, slug, docJson),
    ]);
  } catch {
    return c.json({ error: "Slug already exists" }, 409);
  }

  return c.json({ ok: true, slug });
});

app.patch("/api/pages/:slug", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const slug = c.req.param("slug");
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    nav_title?: string | null;
    published?: boolean | number;
    seo_json?: Record<string, unknown>;
  };

  const page = await c.env.SITE_DB.prepare(
    `SELECT id, title, nav_title, published, seo_json FROM pages WHERE site_id = ? AND slug = ?`
  )
    .bind(SITE_ID, slug)
    .first<{
      id: string;
      title: string | null;
      nav_title: string | null;
      published: number;
      seo_json: string;
    }>();
  if (!page) return c.json({ error: "Not found" }, 404);

  const title =
    body.title !== undefined ? String(body.title).trim() || page.title : page.title;
  const navTitle =
    body.nav_title !== undefined
      ? body.nav_title === null
        ? null
        : String(body.nav_title).trim() || null
      : page.nav_title;
  const published =
    body.published !== undefined
      ? body.published === true || body.published === 1
        ? 1
        : 0
      : page.published;
  let seoJson = page.seo_json || "{}";
  if (body.seo_json && typeof body.seo_json === "object") {
    seoJson = JSON.stringify({ ...parseSeoBag(page.seo_json), ...body.seo_json });
  }

  await c.env.SITE_DB.prepare(
    `UPDATE pages SET title = ?, nav_title = ?, published = ?, seo_json = ? WHERE site_id = ? AND slug = ?`
  )
    .bind(title, navTitle, published, seoJson, SITE_ID, slug)
    .run();

  return c.json({
    ok: true,
    page: { slug, title, nav_title: navTitle, published, seo_json: JSON.parse(seoJson) },
  });
});

app.put("/api/pages/reorder", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as { slugs?: string[] };
  const slugs = Array.isArray(body.slugs) ? body.slugs.map(String) : [];
  if (!slugs.length) return c.json({ error: "slugs required" }, 400);

  const stmts = slugs.map((s, i) =>
    c.env.SITE_DB.prepare(
      `UPDATE pages SET nav_order = ? WHERE site_id = ? AND slug = ?`
    ).bind(i, SITE_ID, s)
  );
  await c.env.SITE_DB.batch(stmts);
  return c.json({ ok: true });
});

app.delete("/api/pages/:slug", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const slug = c.req.param("slug");
  if (slug === "home") {
    return c.json({ error: "Cannot delete the home page" }, 400);
  }
  const page = await c.env.SITE_DB.prepare(
    `SELECT id FROM pages WHERE site_id = ? AND slug = ?`
  )
    .bind(SITE_ID, slug)
    .first();
  if (!page) return c.json({ error: "Not found" }, 404);

  await c.env.SITE_DB.batch([
    c.env.SITE_DB.prepare(`DELETE FROM page_blocks WHERE site_id = ? AND page_slug = ?`).bind(
      SITE_ID,
      slug
    ),
    c.env.SITE_DB.prepare(`DELETE FROM pages WHERE site_id = ? AND slug = ?`).bind(SITE_ID, slug),
  ]);
  return c.json({ ok: true });
});

app.get("/api/media", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const rows = await c.env.SITE_DB.prepare(
    `SELECT id, filename, bytes, r2_key, created_at FROM site_media WHERE site_id = ? ORDER BY created_at DESC LIMIT 200`
  )
    .bind(SITE_ID)
    .all();
  const media = (rows.results ?? []).map((r) => ({
    id: String(r.id),
    filename: String(r.filename),
    bytes: Number(r.bytes) || 0,
    url: `/api/media/${r.id}`,
    createdAt: String(r.created_at),
  }));
  return c.json({ media });
});

app.post("/api/media", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  if (!c.env.MEDIA) {
    return c.json({ error: "R2 MEDIA binding not configured" }, 503);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") {
    return c.json({ error: "file required" }, 400);
  }
  const blob = file as Blob & { name?: string; type: string };
  const id = crypto.randomUUID();
  const filename = blob.name || "upload.bin";
  const r2Key = `sites/${SITE_ID}/${id}/${filename}`;
  const bytes = blob.size;
  const buf = await blob.arrayBuffer();
  await c.env.MEDIA.put(r2Key, buf, {
    httpMetadata: { contentType: blob.type || "application/octet-stream" },
  });
  await c.env.SITE_DB.prepare(
    `INSERT INTO site_media (id, site_id, r2_key, filename, bytes) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, SITE_ID, r2Key, filename, bytes)
    .run();

  return c.json({
    ok: true,
    media: { id, filename, bytes, url: `/api/media/${id}`, mediaKey: r2Key, mediaId: id },
  });
});

app.get("/api/media/:id", async (c) => {
  await ensureSchema(c.env.SITE_DB);
  const id = c.req.param("id");
  const row = await c.env.SITE_DB.prepare(
    `SELECT r2_key, filename FROM site_media WHERE site_id = ? AND id = ?`
  )
    .bind(SITE_ID, id)
    .first<{ r2_key: string; filename: string }>();
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!c.env.MEDIA) return c.json({ error: "R2 MEDIA binding not configured" }, 503);
  const obj = await c.env.MEDIA.get(row.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set(
    "Content-Disposition",
    `inline; filename="${row.filename.replace(/"/g, "")}"`
  );
  return new Response(obj.body, { headers });
});

app.get("/api/settings", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const row = await c.env.SITE_DB.prepare(
    `SELECT settings_json FROM site_settings WHERE site_id = ?`
  )
    .bind(SITE_ID)
    .first<{ settings_json: string }>();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(row?.settings_json || "{}") as Record<string, unknown>;
  } catch {
    settings = {};
  }
  // Never return raw AI API key to the client.
  const ai = (settings.ai || {}) as Record<string, unknown>;
  if (ai.apiKey) {
    settings = {
      ...settings,
      ai: {
        ...ai,
        apiKey: undefined,
        apiKeySet: true,
        apiKeyMasked: `${String(ai.apiKey).slice(0, 4)}…`,
      },
    };
  }
  const assets = (settings.assets || {}) as Record<string, unknown>;
  settings = {
    ...settings,
    assets: {
      unsplashKeySet: Boolean(assets.unsplashKey),
      pexelsKeySet: Boolean(assets.pexelsKey),
    },
  };
  return c.json({ settings });
});

app.put("/api/settings", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as { settings?: Record<string, unknown> };
  if (!body.settings || typeof body.settings !== "object") {
    return c.json({ error: "settings required" }, 400);
  }
  // Preserve existing AI apiKey when client sends masked/empty.
  const existingRow = await c.env.SITE_DB.prepare(
    `SELECT settings_json FROM site_settings WHERE site_id = ?`
  )
    .bind(SITE_ID)
    .first<{ settings_json: string }>();
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(existingRow?.settings_json || "{}") as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const nextSettings = { ...body.settings };
  const nextAi = { ...((nextSettings.ai as Record<string, unknown>) || {}) };
  const prevAi = (existing.ai || {}) as Record<string, unknown>;
  if (!nextAi.apiKey && prevAi.apiKey) {
    nextAi.apiKey = prevAi.apiKey;
  }
  delete nextAi.apiKeySet;
  delete nextAi.apiKeyMasked;
  if (Object.keys(nextAi).length) nextSettings.ai = nextAi;

  const nextAssets = { ...((nextSettings.assets as Record<string, unknown>) || {}) };
  const prevAssets = (existing.assets || {}) as Record<string, unknown>;
  if (!nextAssets.unsplashKey && prevAssets.unsplashKey) {
    nextAssets.unsplashKey = prevAssets.unsplashKey;
  }
  if (!nextAssets.pexelsKey && prevAssets.pexelsKey) {
    nextAssets.pexelsKey = prevAssets.pexelsKey;
  }
  if (Object.keys(nextAssets).length) nextSettings.assets = nextAssets;
  // Ensure MCP token exists
  if (!nextSettings.mcpToken && !existing.mcpToken) {
    nextSettings.mcpToken = crypto.randomUUID().replace(/-/g, "");
  } else if (!nextSettings.mcpToken && existing.mcpToken) {
    nextSettings.mcpToken = existing.mcpToken;
  }

  await c.env.SITE_DB.prepare(
    `INSERT INTO site_settings (site_id, settings_json) VALUES (?, ?)
     ON CONFLICT(site_id) DO UPDATE SET settings_json = excluded.settings_json`
  )
    .bind(SITE_ID, JSON.stringify(nextSettings))
    .run();
  return c.json({ ok: true });
});

app.get("/api/domains", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const rows = await c.env.SITE_DB.prepare(
    `SELECT hostname, is_primary, verified FROM tenant_domains WHERE site_id = ? ORDER BY is_primary DESC, hostname ASC`
  )
    .bind(SITE_ID)
    .all();
  return c.json({ domains: rows.results ?? [] });
});

app.put("/api/domains", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as { hostname?: string };
  const hostname = String(body.hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  await c.env.SITE_DB.prepare(`DELETE FROM tenant_domains WHERE site_id = ?`)
    .bind(SITE_ID)
    .run();

  if (!hostname) {
    return c.json({
      ok: true,
      domains: [],
      instructions: null,
    });
  }

  await c.env.SITE_DB.prepare(
    `INSERT INTO tenant_domains (hostname, site_id, is_primary, verified) VALUES (?, ?, 1, 0)`
  )
    .bind(hostname, SITE_ID)
    .run();

  return c.json({
    ok: true,
    domains: [{ hostname, is_primary: 1, verified: 0 }],
    instructions: {
      steps: [
        "Open Cloudflare Dashboard → Workers & Pages → finnsk-websites-solo → Settings → Domains & Routes",
        `Add Custom Domain: ${hostname} (zone must be on this Cloudflare account)`,
        "Or point a CNAME at your *.workers.dev hostname if DNS is elsewhere",
      ],
    },
  });
});

app.get("/api/modules", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const modules = await listSiteModules(c.env.SITE_DB, SITE_ID);
  return c.json({ modules });
});

app.post("/api/modules/:id/enable", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const id = c.req.param("id");
  const result = await enableModule(c.env.SITE_DB, SITE_ID, id);
  if ("error" in result) return c.json({ error: result.error }, result.status as 404);
  return c.json({ ok: true, moduleId: id, enabled: true });
});

app.post("/api/modules/:id/disable", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const id = c.req.param("id");
  const result = await disableModule(c.env.SITE_DB, SITE_ID, id);
  if ("error" in result) return c.json({ error: result.error }, result.status as 404);
  return c.json({ ok: true, moduleId: id, enabled: false });
});

/** Gate module-owned routes — only when that module is enabled for this site. */
app.use("/api/modules/:id/*", async (c, next) => {
  const id = c.req.param("id");
  const path = c.req.path;
  if (!id || path.endsWith("/enable") || path.endsWith("/disable")) {
    return next();
  }
  await ensureSchema(c.env.SITE_DB);
  if (!(await isModuleEnabled(c.env.SITE_DB, SITE_ID, id))) {
    return c.json({ error: "Module not enabled", code: "MODULE_DISABLED" }, 403);
  }
  return next();
});

forEachModuleWithRoutes((mod) => {
  const sub = new Hono<{ Bindings: SoloEnv }>();
  mod.mountRoutes?.(sub);
  app.route(`/api/modules/${mod.id}`, sub);
});

async function loadSettings(db: D1Database): Promise<Record<string, unknown>> {
  const row = await db
    .prepare(`SELECT settings_json FROM site_settings WHERE site_id = ?`)
    .bind(SITE_ID)
    .first<{ settings_json: string }>();
  try {
    return JSON.parse(row?.settings_json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function getPageDocument(db: D1Database, slug: string): Promise<unknown | null> {
  const block = await db
    .prepare(
      `SELECT props_json FROM page_blocks
       WHERE site_id = ? AND page_slug = ? AND component_type = 'ProposalDocument' LIMIT 1`
    )
    .bind(SITE_ID, slug)
    .first<{ props_json: string }>();
  if (!block) return null;
  try {
    return JSON.parse(block.props_json) as unknown;
  } catch {
    return null;
  }
}

async function savePageDocument(db: D1Database, slug: string, document: unknown): Promise<void> {
  const propsJson = JSON.stringify(document);
  const existing = await db
    .prepare(
      `SELECT id FROM page_blocks
       WHERE site_id = ? AND page_slug = ? AND component_type = 'ProposalDocument' LIMIT 1`
    )
    .bind(SITE_ID, slug)
    .first<{ id: string }>();
  if (existing) {
    await db.prepare(`UPDATE page_blocks SET props_json = ? WHERE id = ?`).bind(propsJson, existing.id).run();
  } else {
    await db
      .prepare(
        `INSERT INTO page_blocks (id, site_id, page_slug, component_type, props_json, order_index)
         VALUES (?, ?, ?, 'ProposalDocument', ?, 0)`
      )
      .bind(crypto.randomUUID(), SITE_ID, slug, propsJson)
      .run();
  }
  await db
    .prepare(
      `UPDATE pages SET html_cache_revision = html_cache_revision + 1 WHERE site_id = ? AND slug = ?`
    )
    .bind(SITE_ID, slug)
    .run();
}

function makeMcpStore(db: D1Database): McpDocStore {
  return {
    listPages: async () => {
      const rows = await db
        .prepare(
          `SELECT slug, title FROM pages WHERE site_id = ? ORDER BY nav_order ASC, slug ASC`
        )
        .bind(SITE_ID)
        .all<{ slug: string; title: string | null }>();
      return (rows.results ?? []).map((r) => ({
        slug: r.slug,
        title: r.title || r.slug,
      }));
    },
    getDocument: (slug) => getPageDocument(db, slug),
    saveDocument: (slug, document) => savePageDocument(db, slug, document),
    listMedia: async () => {
      const rows = await db
        .prepare(
          `SELECT id, filename, bytes FROM site_media WHERE site_id = ? ORDER BY created_at DESC LIMIT 100`
        )
        .bind(SITE_ID)
        .all();
      return rows.results ?? [];
    },
    createPage: async (slug, title, document) => {
      const existing = await db
        .prepare(`SELECT slug FROM pages WHERE site_id = ? AND slug = ?`)
        .bind(SITE_ID, slug)
        .first<{ slug: string }>();
      if (existing) {
        return { ok: true, slug, created: false };
      }
      const propsJson =
        document != null
          ? JSON.stringify(document)
          : blankHomeDocumentJson();
      await db.batch([
        db
          .prepare(
            `INSERT INTO pages (id, site_id, slug, title, nav_order, published, seo_json)
             VALUES (?, ?, ?, ?, 100, 1, '{}')`
          )
          .bind(crypto.randomUUID(), SITE_ID, slug, title),
        db
          .prepare(
            `INSERT INTO page_blocks (id, site_id, page_slug, component_type, props_json, order_index)
             VALUES (?, ?, ?, 'ProposalDocument', ?, 0)`
          )
          .bind(crypto.randomUUID(), SITE_ID, slug, propsJson),
      ]);
      return { ok: true, slug, created: true };
    },
  };
}

async function requireUserOrMcpToken(
  c: Context<{ Bindings: SoloEnv; Variables: Variables }>
): Promise<true | Response> {
  const auth = await requireUser(c);
  if (!(auth instanceof Response)) return true;

  const header = c.req.header("authorization") || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) return c.json({ error: "Unauthorized" }, 401);
  await ensureSchema(c.env.SITE_DB);
  const settings = await loadSettings(c.env.SITE_DB);
  if (settings.mcpToken && settings.mcpToken === bearer) return true;
  return c.json({ error: "Unauthorized" }, 401);
}

/** Atomic ops — shared by studio AI approve + MCP. */
app.post("/api/ops/preview", async (c) => {
  const gate = await requireUserOrMcpToken(c);
  if (gate !== true) return gate;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    pageSlug?: string;
    ops?: unknown[];
  };
  const slug = String(body.pageSlug || "home");
  const doc = await getPageDocument(c.env.SITE_DB, slug);
  if (!doc) return c.json({ error: "Not found" }, 404);
  const result = runOps(doc, body.ops || []);
  return c.json({
    ok: result.ok,
    errors: result.errors,
    summaries: result.summaries,
    diffSummary: summarizeDiff(doc, result.document),
    document: result.document,
  });
});

app.post("/api/ops/apply", async (c) => {
  const gate = await requireUserOrMcpToken(c);
  if (gate !== true) return gate;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    pageSlug?: string;
    ops?: unknown[];
  };
  const slug = String(body.pageSlug || "home");
  const doc = await getPageDocument(c.env.SITE_DB, slug);
  if (!doc) return c.json({ error: "Not found" }, 404);
  const result = runOps(doc, body.ops || []);
  if (!result.ok) {
    return c.json(
      {
        error: "Validation failed",
        errors: result.errors,
        summaries: result.summaries,
      },
      400
    );
  }
  await savePageDocument(c.env.SITE_DB, slug, result.document);
  return c.json({
    ok: true,
    summaries: result.summaries,
    document: result.document,
  });
});

app.get("/api/ai/cookbook", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  return c.json({ motion: MOTION_COOKBOOK, scene3d: SCENE3D_COOKBOOK });
});

app.get("/api/icons/collections", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  const q = c.req.query("q") || undefined;
  const limit = Number(c.req.query("limit") || 50);
  return c.json({
    collections: listIconCollections({ query: q, limit }),
  });
});

app.get("/api/icons/search", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  const query = String(c.req.query("q") || "").trim();
  if (!query) return c.json({ error: "q required" }, 400);
  const result = await searchIcons({
    query,
    prefix: c.req.query("prefix") || undefined,
    limit: Number(c.req.query("limit") || 24),
  });
  return c.json(result);
});

app.post("/api/ai/agent", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    message?: string;
    history?: AgentMessage[];
    pageSlug?: string;
    selection?: { sectionId?: string; blockId?: string | null };
    uploadedMedia?: { mediaId?: string; filename?: string } | null;
    stream?: boolean;
  };
  const message = String(body.message || "").trim();
  if (!message && !body.uploadedMedia?.mediaId) {
    return c.json({ error: "message required" }, 400);
  }

  const settings = await loadSettings(c.env.SITE_DB);
  const ai = (settings.ai || {}) as AiSettings;
  if (!ai.apiKey) {
    return c.json(
      {
        error: "Add a Gemini API key under Design → AI, then try again.",
        code: "AI_KEY_MISSING",
      },
      400
    );
  }

  const wantStream =
    body.stream === true ||
    (c.req.header("accept") || "").includes("text/event-stream");

  const runOpts = {
    apiKey: String(ai.apiKey),
    model: ai.model ? String(ai.model) : undefined,
    store: makeMcpStore(c.env.SITE_DB),
    message: message || "Continue with the uploaded asset.",
    history: Array.isArray(body.history) ? body.history : [],
    pageSlug: body.pageSlug,
    selection: body.selection,
    uploadedMedia: body.uploadedMedia || null,
  };

  if (!wantStream) {
    try {
      const turn = await runDesignAgentTurn(runOpts);
      return c.json(turn);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Agent failed" },
        500
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      };
      try {
        await runDesignAgentTurn({
          ...runOpts,
          onEvent: async (ev) => {
            send(ev);
          },
        });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? e.message : "Agent failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

app.post("/api/ai/compose", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    pageSlug?: string;
    prompt?: string;
    mode?: string;
    autoApply?: boolean;
    selection?: { sectionId?: string; blockId?: string | null };
  };
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return c.json({ error: "prompt required" }, 400);
  const slug = String(body.pageSlug || "home");
  const doc = await getPageDocument(c.env.SITE_DB, slug);
  if (!doc) return c.json({ error: "Not found" }, 404);

  const settings = await loadSettings(c.env.SITE_DB);
  const ai = (settings.ai || {}) as AiSettings;
  if (!ai.apiKey) {
    return c.json(
      {
        error:
          "Add a Gemini API key under Settings → AI, then try again.",
        code: "AI_KEY_MISSING",
      },
      400
    );
  }

  try {
    const plan = await composeOpsWithGemini({
      apiKey: String(ai.apiKey),
      model: ai.model ? String(ai.model) : undefined,
      prompt,
      document: doc,
      selection: body.selection,
      mode: body.mode,
    });
    // Normalize Gemini quirks (short ids, missing tracks, etc.) then preview.
    plan.ops = normalizeOps(doc, plan.ops);
    const preview = previewCompose(doc, plan.ops);
    if (body.autoApply && preview.ok) {
      await savePageDocument(c.env.SITE_DB, slug, preview.document);
      return c.json({
        plan,
        preview,
        applied: true,
        document: preview.document,
      });
    }
    return c.json({ plan, preview, applied: false });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Compose failed" },
      500
    );
  }
});

app.post("/api/ai/token", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const settings = await loadSettings(c.env.SITE_DB);
  const token = crypto.randomUUID().replace(/-/g, "");
  settings.mcpToken = token;
  await c.env.SITE_DB.prepare(
    `INSERT INTO site_settings (site_id, settings_json) VALUES (?, ?)
     ON CONFLICT(site_id) DO UPDATE SET settings_json = excluded.settings_json`
  )
    .bind(SITE_ID, JSON.stringify(settings))
    .run();
  return c.json({ mcpToken: token });
});

/* ── Collections CMS ─────────────────────────────────────────────── */

app.get("/api/collections/presets", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  return c.json({ presets: COLLECTION_PRESETS });
});

app.get("/api/collections", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const rows = await listCollections(c.env.SITE_DB);
  return c.json({
    collections: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      fields: parseFields(r.fields_json),
      createdAt: r.created_at,
    })),
  });
});

app.post("/api/collections", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    slug?: string;
    presetId?: string;
    fields?: unknown;
  };
  const created = await createCollection(c.env.SITE_DB, {
    name: String(body.name ?? ""),
    slug: body.slug ? String(body.slug) : undefined,
    presetId: body.presetId ? String(body.presetId) : undefined,
    fields: Array.isArray(body.fields) ? (body.fields as Parameters<typeof createCollection>[1]["fields"]) : undefined,
  });
  return c.json({ collection: created }, 201);
});

app.get("/api/collections/:id", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const row = await getCollection(c.env.SITE_DB, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({
    collection: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      fields: parseFields(row.fields_json),
      createdAt: row.created_at,
    },
  });
});

app.patch("/api/collections/:id", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    fields?: unknown;
  };
  const updated = await updateCollection(c.env.SITE_DB, c.req.param("id"), {
    name: body.name,
    fields: Array.isArray(body.fields)
      ? (body.fields as Parameters<typeof updateCollection>[2]["fields"])
      : undefined,
  });
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json({
    collection: {
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      fields: parseFields(updated.fields_json),
    },
  });
});

app.post("/api/collections/:id/site-pages", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const coll = await getCollection(c.env.SITE_DB, c.req.param("id"));
  if (!coll) return c.json({ error: "Not found" }, 404);
  const fields = parseFields(coll.fields_json);
  const indexExisting = await findCollectionPage(c.env.SITE_DB, "collection-index", coll.id);
  const itemExisting = await findCollectionPage(c.env.SITE_DB, "collection-item", coll.id);

  const insertPage = async (slug: string, title: string, seo: Record<string, unknown>, doc: PageDoc) => {
    await c.env.SITE_DB.batch([
      c.env.SITE_DB.prepare(
        `INSERT INTO pages (id, site_id, slug, title, nav_order, published, seo_json)
         VALUES (?, ?, ?, ?, 80, 1, ?)`
      ).bind(crypto.randomUUID(), SITE_ID, slug, title, JSON.stringify(seo)),
      c.env.SITE_DB.prepare(
        `INSERT INTO page_blocks (id, site_id, page_slug, component_type, props_json, order_index)
         VALUES (?, ?, ?, 'ProposalDocument', ?, 0)`
      ).bind(crypto.randomUUID(), SITE_ID, slug, JSON.stringify(doc)),
    ]);
  };

  let indexSlug = indexExisting?.slug || coll.slug;
  let itemSlug = itemExisting?.slug || `${coll.slug}--item`;
  try {
    if (!indexExisting) {
      await insertPage(
        indexSlug,
        coll.name,
        {
          pageKind: "collection-index",
          collectionId: coll.id,
          collectionSlug: coll.slug,
          metaTitle: coll.name,
        },
        collectionIndexDocument({ name: coll.name, fields })
      );
    }
    if (!itemExisting) {
      await insertPage(
        itemSlug,
        `${coll.name} item`,
        {
          pageKind: "collection-item",
          collectionId: coll.id,
          collectionSlug: coll.slug,
          metaTitle: coll.name,
        },
        collectionItemDocument({ name: coll.name, fields })
      );
    }
  } catch {
    return c.json(
      { error: `A page already uses /${coll.slug}. Rename that page, then try again.` },
      409
    );
  }

  return c.json({
    ok: true,
    indexSlug,
    itemSlug,
    createdIndex: !indexExisting,
    createdItem: !itemExisting,
  });
});

app.delete("/api/collections/:id", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const ok = await deleteCollection(c.env.SITE_DB, c.req.param("id"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/collections/:id/items", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const coll = await getCollection(c.env.SITE_DB, c.req.param("id"));
  if (!coll) return c.json({ error: "Not found" }, 404);
  const items = await listItems(c.env.SITE_DB, coll.id);
  return c.json({
    items: items.map((i) => ({
      id: i.id,
      slug: i.slug,
      status: i.status,
      data: JSON.parse(i.data_json || "{}"),
      sort: i.sort,
      publishedAt: i.published_at,
      updatedAt: i.updated_at,
    })),
  });
});

app.post("/api/collections/:id/items", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const coll = await getCollection(c.env.SITE_DB, c.req.param("id"));
  if (!coll) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: string;
    status?: string;
    data?: Record<string, unknown>;
    sort?: number;
  };
  const item = await upsertItem(c.env.SITE_DB, coll.id, {
    slug: body.slug,
    status: body.status,
    data: body.data,
    sort: body.sort,
  });
  return c.json({ item }, 201);
});

app.patch("/api/collections/:id/items/:itemId", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const coll = await getCollection(c.env.SITE_DB, c.req.param("id"));
  if (!coll) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: string;
    status?: string;
    data?: Record<string, unknown>;
    sort?: number;
  };
  const item = await upsertItem(c.env.SITE_DB, coll.id, {
    id: c.req.param("itemId"),
    slug: body.slug,
    status: body.status,
    data: body.data,
    sort: body.sort,
  });
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json({ item });
});

app.delete("/api/collections/:id/items/:itemId", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const coll = await getCollection(c.env.SITE_DB, c.req.param("id"));
  if (!coll) return c.json({ error: "Not found" }, 404);
  const ok = await deleteItem(c.env.SITE_DB, coll.id, c.req.param("itemId"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/seo/audit", async (c) => {
  const auth = await requireUser(c);
  if (auth instanceof Response) return auth;
  await ensureSchema(c.env.SITE_DB);
  const pages = await c.env.SITE_DB.prepare(
    `SELECT slug, title, published, seo_json FROM pages WHERE site_id = ?`
  )
    .bind(SITE_ID)
    .all<{ slug: string; title: string | null; published: number; seo_json: string }>();
  const settings = await loadSettings(c.env.SITE_DB);
  const siteSeo = (settings.seo || {}) as {
    metaTitle?: string;
    metaDescription?: string;
    ogImage?: string;
  };
  const audit = runSeoAudit({
    pages: pages.results ?? [],
    siteSeo,
    hasRobots: true,
    hasSitemap: true,
  });
  return c.json({ audit });
});

app.get("/robots.txt", async (c) => {
  await ensureSchema(c.env.SITE_DB);
  const origin = new URL(c.req.url).origin;
  return c.text(buildRobotsTxt(origin), 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
});

app.get("/sitemap.xml", async (c) => {
  await ensureSchema(c.env.SITE_DB);
  const origin = new URL(c.req.url).origin;
  const pages = await c.env.SITE_DB.prepare(
    `SELECT slug, created_at FROM pages WHERE site_id = ? AND published = 1`
  )
    .bind(SITE_ID)
    .all<{ slug: string; created_at: string }>();
  const urls: Array<{ loc: string; lastmod?: string }> = (pages.results ?? []).map((p) => ({
    loc: p.slug === "home" ? "/" : `/${p.slug}`,
    lastmod: p.created_at?.slice(0, 10),
  }));
  const collections = await listCollections(c.env.SITE_DB);
  for (const coll of collections) {
    const items = await listItems(c.env.SITE_DB, coll.id, { publishedOnly: true });
    for (const item of items) {
      const lm = (item.updated_at || item.published_at || "").slice(0, 10);
      urls.push({
        loc: `/${coll.slug}/${item.slug}`,
        ...(lm ? { lastmod: lm } : {}),
      });
    }
  }
  return c.text(buildSitemapXml(origin, urls), 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=600",
  });
});

/** MCP JSON-RPC (Streamable HTTP / classic POST). */
app.all("/mcp", async (c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return c.json({
      name: "finnsk-solo",
      version: "0.1.0",
      transport: "json-rpc",
      hint: "POST JSON-RPC initialize / tools/list / tools/call with Authorization: Bearer <mcpToken>",
    });
  }
  const gate = await requireUserOrMcpToken(c);
  if (gate !== true) return gate;
  await ensureSchema(c.env.SITE_DB);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "JSON body required" }, 400);
  const store = makeMcpStore(c.env.SITE_DB);
  const result = await handleMcpJsonRpc(store, body);
  return c.json(result);
});

app.all("/api/mcp", async (c) => {
  // Alias under /api for assets run_worker_first
  const url = new URL(c.req.url);
  url.pathname = "/mcp";
  return app.fetch(new Request(url.toString(), c.req.raw), c.env, c.executionCtx);
});

function htmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isPublicDocumentPath(pathname: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/mcp") ||
    pathname.startsWith("/edit") ||
    pathname.startsWith("/assets/")
  ) {
    return false;
  }
  if (pathname === "/robots.txt" || pathname === "/sitemap.xml") return false;
  const last = pathname.split("/").filter(Boolean).pop() || "";
  if (last.includes(".")) return false;
  return true;
}

/** SPA fallback. Public URLs get the built index.html with SEO tags + bootstrap JSON. */
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  if (c.env.ASSETS && isPublicDocumentPath(url.pathname, c.req.method)) {
    await ensureSchema(c.env.SITE_DB);
    const slug = url.pathname.replace(/^\/+|\/+$/g, "") || "home";
    const payload = await buildPublicPayload(c.env.SITE_DB, slug);
    const indexUrl = new URL("/index.html", url.origin);
    const asset = await c.env.ASSETS.fetch(new Request(indexUrl.toString(), { method: "GET" }));
    if (asset.ok && !("error" in payload)) {
      const rawSettings = await loadSettingsRaw(c.env.SITE_DB);
      const siteSeo = (rawSettings.seo || {}) as Record<string, string | undefined>;
      const code = (rawSettings.customCode || {}) as {
        enabled?: boolean;
        head?: string;
        body?: string;
      };
      const meta = payload.pageMeta || {};
      const title = String(meta.documentTitle || "Site");
      const description = typeof meta.description === "string" ? meta.description : "";
      const ogImage = typeof meta.ogImage === "string" ? meta.ogImage : siteSeo.ogImage || "";
      const canonical = new URL(slug === "home" ? "/" : `/${slug}`, url.origin).toString();
      const robots = typeof meta.robots === "string" ? meta.robots : "index,follow";
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": slug.includes("/") ? (payload.pageMeta?.ogImage ? "Article" : "WebPage") : "WebPage",
        name: title,
        ...(description ? { description } : {}),
        url: canonical,
        ...(ogImage ? { image: ogImage } : {}),
      };
      const favicon = siteSeo.favicon
        ? `<link rel="icon" href="${htmlEsc(siteSeo.favicon)}"/>`
        : "";
      const theme = siteSeo.themeColor
        ? `<meta name="theme-color" content="${htmlEsc(siteSeo.themeColor)}"/>`
        : "";
      const css =
        typeof rawSettings.customCss === "string" && rawSettings.customCss.trim()
          ? `<style id="fk-custom-css">${rawSettings.customCss.replace(/<\/style/gi, "")}</style>`
          : "";
      const headJs = code.enabled && code.head ? code.head : "";
      const bodyJs = code.enabled && code.body ? code.body : "";
      const tags = [
        description ? `<meta name="description" content="${htmlEsc(description)}"/>` : "",
        `<meta name="robots" content="${htmlEsc(robots)}"/>`,
        `<link rel="canonical" href="${htmlEsc(canonical)}"/>`,
        `<meta property="og:type" content="website"/>`,
        `<meta property="og:title" content="${htmlEsc(title)}"/>`,
        description ? `<meta property="og:description" content="${htmlEsc(description)}"/>` : "",
        ogImage ? `<meta property="og:image" content="${htmlEsc(ogImage)}"/>` : "",
        `<meta property="og:url" content="${htmlEsc(canonical)}"/>`,
        `<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}"/>`,
        `<meta name="twitter:title" content="${htmlEsc(title)}"/>`,
        favicon,
        theme,
        `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`,
        css,
        headJs,
        `<script type="application/json" id="fk-public-bootstrap">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`,
      ]
        .filter(Boolean)
        .join("");
      let html = await asset.text();
      html = html.replace(/<title>[^<]*<\/title>/i, `<title>${htmlEsc(title)}</title>`);
      html = html.replace("</head>", `${tags}</head>`);
      if (bodyJs) html = html.replace("</body>", `${bodyJs}</body>`);
      return c.html(html, 200, {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      });
    }
  }
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"/><title>Finnsk</title></head>
     <body style="font-family:system-ui;padding:2rem">
       <h1>Finnsk Solo</h1>
       <p>API is live. Build the Solo web app assets, then redeploy.</p>
       <p><a href="/api/health">/api/health</a> · <a href="/api/setup/status">/api/setup/status</a></p>
     </body></html>`,
    200
  );
});

export default app;
