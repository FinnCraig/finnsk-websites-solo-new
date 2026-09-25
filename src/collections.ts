/**
 * Collection presets + D1 helpers for Solo CMS.
 */
import { SOLO_DEFAULT_SITE_ID } from "./schema";

const SITE_ID = SOLO_DEFAULT_SITE_ID;

export type FieldType =
  | "text"
  | "richtext"
  | "number"
  | "date"
  | "tags"
  | "image"
  | "images"
  | "url"
  | "boolean";

export type CollectionField = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
};

export type CollectionPreset = {
  id: string;
  name: string;
  slug: string;
  description: string;
  fields: CollectionField[];
};

export const COLLECTION_PRESETS: CollectionPreset[] = [
  {
    id: "blog",
    name: "Blog",
    slug: "blog",
    description: "Posts with title, body, cover, and tags.",
    fields: [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "body", label: "Body", type: "richtext" },
      { key: "cover", label: "Cover", type: "image" },
      { key: "tags", label: "Tags", type: "tags" },
      { key: "publishedAt", label: "Published", type: "date" },
    ],
  },
  {
    id: "products",
    name: "Products",
    slug: "products",
    description: "Catalog items with gallery and price.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "description", label: "Description", type: "richtext" },
      { key: "price", label: "Price", type: "number" },
      { key: "gallery", label: "Gallery", type: "images" },
      { key: "tags", label: "Tags", type: "tags" },
      { key: "url", label: "URL", type: "url" },
    ],
  },
  {
    id: "projects",
    name: "Projects",
    slug: "projects",
    description: "Portfolio case studies.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "summary", label: "Summary", type: "text" },
      { key: "cover", label: "Cover", type: "image" },
      { key: "gallery", label: "Gallery", type: "images" },
      { key: "tags", label: "Tags", type: "tags" },
      { key: "date", label: "Date", type: "date" },
      { key: "url", label: "URL", type: "url" },
    ],
  },
  {
    id: "team",
    name: "Team",
    slug: "team",
    description: "People with roles and photos.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "role", label: "Role", type: "text" },
      { key: "bio", label: "Bio", type: "richtext" },
      { key: "photo", label: "Photo", type: "image" },
      { key: "email", label: "Email / URL", type: "url" },
      { key: "order", label: "Order", type: "number" },
    ],
  },
  {
    id: "services",
    name: "Services",
    slug: "services",
    description: "Service offerings.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "description", label: "Description", type: "richtext" },
      { key: "image", label: "Image", type: "image" },
      { key: "price", label: "Price", type: "number" },
    ],
  },
  {
    id: "testimonials",
    name: "Testimonials",
    slug: "testimonials",
    description: "Quotes from customers.",
    fields: [
      { key: "quote", label: "Quote", type: "text", required: true },
      { key: "author", label: "Author", type: "text", required: true },
      { key: "role", label: "Role", type: "text" },
      { key: "avatar", label: "Avatar", type: "image" },
      { key: "rating", label: "Rating", type: "number" },
    ],
  },
  {
    id: "blank",
    name: "Blank",
    slug: "items",
    description: "Start with title only — add fields yourself.",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
  },
];

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export type CollectionRow = {
  id: string;
  slug: string;
  name: string;
  fields_json: string;
  created_at: string;
};

export type ItemRow = {
  id: string;
  collection_id: string;
  slug: string;
  status: string;
  data_json: string;
  sort: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function listCollections(db: D1Database): Promise<CollectionRow[]> {
  const res = await db
    .prepare(
      `SELECT id, slug, name, fields_json, created_at FROM collections WHERE site_id = ? ORDER BY name`
    )
    .bind(SITE_ID)
    .all<CollectionRow>();
  return res.results ?? [];
}

export async function getCollection(
  db: D1Database,
  idOrSlug: string
): Promise<CollectionRow | null> {
  return (
    (await db
      .prepare(
        `SELECT id, slug, name, fields_json, created_at FROM collections
         WHERE site_id = ? AND (id = ? OR slug = ?) LIMIT 1`
      )
      .bind(SITE_ID, idOrSlug, idOrSlug)
      .first<CollectionRow>()) ?? null
  );
}

export async function createCollection(
  db: D1Database,
  opts: { name: string; slug?: string; fields?: CollectionField[]; presetId?: string }
): Promise<{ id: string; slug: string; name: string; fields: CollectionField[] }> {
  const preset = opts.presetId
    ? COLLECTION_PRESETS.find((p) => p.id === opts.presetId)
    : undefined;
  const fields = opts.fields?.length ? opts.fields : preset?.fields ?? [];
  const name = (opts.name || preset?.name || "Collection").trim();
  let slug = slugify(opts.slug || preset?.slug || name);
  if (!slug) slug = "collection";

  const existing = await getCollection(db, slug);
  if (existing) {
    slug = `${slug}-${crypto.randomUUID().slice(0, 6)}`;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO collections (id, site_id, slug, name, fields_json) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, SITE_ID, slug, name, JSON.stringify(fields))
    .run();
  return { id, slug, name, fields };
}

export async function updateCollection(
  db: D1Database,
  id: string,
  opts: { name?: string; fields?: CollectionField[] }
): Promise<CollectionRow | null> {
  const cur = await getCollection(db, id);
  if (!cur) return null;
  const name = opts.name?.trim() || cur.name;
  const fieldsJson = opts.fields ? JSON.stringify(opts.fields) : cur.fields_json;
  await db
    .prepare(`UPDATE collections SET name = ?, fields_json = ? WHERE site_id = ? AND id = ?`)
    .bind(name, fieldsJson, SITE_ID, cur.id)
    .run();
  return getCollection(db, cur.id);
}

export async function deleteCollection(db: D1Database, id: string): Promise<boolean> {
  const cur = await getCollection(db, id);
  if (!cur) return false;
  await db
    .prepare(`DELETE FROM collection_items WHERE site_id = ? AND collection_id = ?`)
    .bind(SITE_ID, cur.id)
    .run();
  await db
    .prepare(`DELETE FROM collections WHERE site_id = ? AND id = ?`)
    .bind(SITE_ID, cur.id)
    .run();
  return true;
}

export async function listItems(
  db: D1Database,
  collectionId: string,
  opts?: { publishedOnly?: boolean }
): Promise<ItemRow[]> {
  const sql = opts?.publishedOnly
    ? `SELECT * FROM collection_items WHERE site_id = ? AND collection_id = ? AND status = 'published'
       ORDER BY sort ASC, published_at DESC`
    : `SELECT * FROM collection_items WHERE site_id = ? AND collection_id = ?
       ORDER BY sort ASC, updated_at DESC`;
  const res = await db.prepare(sql).bind(SITE_ID, collectionId).all<ItemRow>();
  return res.results ?? [];
}

export async function getItem(
  db: D1Database,
  collectionId: string,
  idOrSlug: string
): Promise<ItemRow | null> {
  return (
    (await db
      .prepare(
        `SELECT * FROM collection_items WHERE site_id = ? AND collection_id = ?
         AND (id = ? OR slug = ?) LIMIT 1`
      )
      .bind(SITE_ID, collectionId, idOrSlug, idOrSlug)
      .first<ItemRow>()) ?? null
  );
}

export async function upsertItem(
  db: D1Database,
  collectionId: string,
  opts: {
    id?: string;
    slug?: string;
    status?: string;
    data?: Record<string, unknown>;
    sort?: number;
  }
): Promise<ItemRow | null> {
  const coll = await getCollection(db, collectionId);
  if (!coll) return null;

  const data = opts.data ?? {};
  const titleish =
    String(data.title ?? data.name ?? data.author ?? data.quote ?? "item").slice(0, 80) ||
    "item";
  let slug = slugify(opts.slug || titleish);
  if (!slug) slug = "item";
  const status = opts.status === "published" ? "published" : "draft";
  const sort = typeof opts.sort === "number" ? opts.sort : 0;
  const publishedAt = status === "published" ? new Date().toISOString() : null;

  if (opts.id) {
    const existing = await getItem(db, coll.id, opts.id);
    if (!existing) return null;
    await db
      .prepare(
        `UPDATE collection_items SET slug = ?, status = ?, data_json = ?, sort = ?,
         published_at = COALESCE(?, published_at), updated_at = datetime('now')
         WHERE site_id = ? AND id = ?`
      )
      .bind(
        slug,
        status,
        JSON.stringify(data),
        sort,
        publishedAt,
        SITE_ID,
        existing.id
      )
      .run();
    return getItem(db, coll.id, existing.id);
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO collection_items
       (id, site_id, collection_id, slug, status, data_json, sort, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, SITE_ID, coll.id, slug, status, JSON.stringify(data), sort, publishedAt)
    .run();
  return getItem(db, coll.id, id);
}

export async function deleteItem(
  db: D1Database,
  collectionId: string,
  itemId: string
): Promise<boolean> {
  const r = await db
    .prepare(
      `DELETE FROM collection_items WHERE site_id = ? AND collection_id = ? AND id = ?`
    )
    .bind(SITE_ID, collectionId, itemId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

export function parseFields(fieldsJson: string): CollectionField[] {
  try {
    const raw = JSON.parse(fieldsJson) as unknown;
    return Array.isArray(raw) ? (raw as CollectionField[]) : [];
  } catch {
    return [];
  }
}
