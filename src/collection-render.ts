/**
 * Resolve collection index / item templates into a public PageDocument.
 * Stored documents keep one card; the public payload expands repeats.
 */

export type CollectionItemData = Record<string, unknown>;

type Block = {
  id: string;
  type: string;
  bind?: { path?: string };
  props?: Record<string, unknown>;
  placement?: unknown;
  links?: unknown;
};

type Section = {
  id: string;
  settings?: Record<string, unknown>;
  blocks?: Block[];
};

export type PageDoc = {
  schemaVersion?: number;
  pages?: Section[];
  [key: string]: unknown;
};

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function lookup(data: CollectionItemData, path: string, itemHref: string): string {
  if (path === "itemHref" || path === "href") return itemHref;
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = data;
  for (const part of parts) {
    if (cur == null) return "";
    if (Array.isArray(cur) && /^\d+$/.test(part)) {
      cur = cur[Number(part)];
      continue;
    }
    if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
      continue;
    }
    return "";
  }
  if (Array.isArray(cur)) {
    const first = cur[0];
    if (first && typeof first === "object" && "src" in (first as object)) {
      return String((first as { src?: unknown }).src ?? "");
    }
    return cur.map((v) => (typeof v === "string" ? v : "")).filter(Boolean).join(", ");
  }
  if (cur == null || typeof cur === "object") return "";
  return String(cur);
}

function replaceTokens(value: string, data: CollectionItemData, itemHref: string): string {
  return value.replace(TOKEN, (_m, path: string) => lookup(data, path, itemHref));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function applyBlock(block: Block, data: CollectionItemData, itemHref: string): Block {
  const next: Block = {
    ...block,
    props: { ...(block.props || {}) },
  };
  const props = next.props || {};
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (typeof v === "string" && v.includes("{{")) {
      props[key] = replaceTokens(v, data, itemHref);
    }
  }
  const originalHtml = typeof (block.props || {}).html === "string" ? String(block.props?.html) : "";
  const path = block.bind?.path?.trim();
  if (path) {
    const val = lookup(data, path, itemHref);
    if (next.type === "Text" && val && !originalHtml.includes("{{")) {
      props.html = `<p>${escapeHtml(val)}</p>`;
    } else if (next.type === "Image" && val) {
      props.src = val;
      const alt = lookup(data, "name", itemHref) || lookup(data, "title", itemHref);
      if (alt && !props.alt) props.alt = alt;
    } else if (next.type === "Button") {
      if (path === "url" || path === "href") props.href = val || itemHref;
      else if (val) props.label = val;
      if (!props.href) props.href = itemHref;
    }
  }
  if (next.type === "Button" && (!props.href || props.href === "#")) {
    props.href = itemHref;
  }
  next.props = props;
  return next;
}

export function applyItemToDocument(
  doc: PageDoc,
  data: CollectionItemData,
  itemHref: string
): PageDoc {
  const clone = structuredClone(doc) as PageDoc;
  clone.pages = (clone.pages || []).map((section) => ({
    ...section,
    blocks: (section.blocks || []).map((b) => applyBlock(b, data, itemHref)),
  }));
  return clone;
}

export function expandCollectionIndex(
  doc: PageDoc,
  items: Array<{ slug: string; data: CollectionItemData }>,
  collectionSlug: string
): PageDoc {
  const clone = structuredClone(doc) as PageDoc;
  const pages: Section[] = [];
  for (const section of clone.pages || []) {
    if (section.settings?.dataRepeat !== "items") {
      pages.push(section);
      continue;
    }
    if (items.length === 0) {
      pages.push({
        ...section,
        settings: { ...(section.settings || {}), dataRepeat: undefined },
        blocks: [
          block(
            "Text",
            { colStart: 2, colEnd: 16, rowStart: 2, rowEnd: 4 },
            {
              html: "<p>Nothing published yet.</p>",
              textRole: "body",
            }
          ),
        ],
      });
      continue;
    }
    for (const item of items) {
      const href = `/${collectionSlug}/${item.slug}`;
      const copy = structuredClone(section) as Section;
      copy.id = crypto.randomUUID();
      copy.blocks = (copy.blocks || []).map((b) => ({
        ...applyBlock(b, item.data, href),
        id: crypto.randomUUID(),
      }));
      pages.push(copy);
    }
  }
  clone.pages = pages;
  return clone;
}

function block(
  type: string,
  placement: { colStart: number; colEnd: number; rowStart: number; rowEnd: number },
  props: Record<string, unknown>,
  bind?: string
): Block {
  return {
    id: crypto.randomUUID(),
    type,
    placement: {
      desktop: placement,
      gridColumn: `${placement.colStart} / ${placement.colEnd}`,
      gridRow: `${placement.rowStart} / ${placement.rowEnd}`,
      zIndex: 1,
    },
    props,
    ...(bind ? { bind: { path: bind } } : {}),
  };
}

function section(blocks: Block[], extra?: Record<string, unknown>): Section {
  return {
    id: crypto.randomUUID(),
    settings: {
      sectionType: "lava",
      minHeight: "420px",
      fullWidth: false,
      backgroundColor: "#ffffff",
      ...extra,
    },
    blocks,
  };
}

function titleKey(fields: Array<{ key: string }>): string {
  return fields.find((f) => f.key === "title" || f.key === "name")?.key || fields[0]?.key || "title";
}

function imageKey(fields: Array<{ key: string; type: string }>): string | null {
  const img = fields.find((f) => f.type === "image");
  if (img) return img.key;
  const gallery = fields.find((f) => f.type === "images");
  return gallery ? `${gallery.key}.0` : null;
}

function bodyKey(fields: Array<{ key: string; type: string }>): string | null {
  const rich = fields.find(
    (f) =>
      f.type === "richtext" ||
      f.key === "summary" ||
      f.key === "description" ||
      f.key === "bio" ||
      f.key === "quote"
  );
  return rich?.key ?? null;
}

export function collectionIndexDocument(opts: {
  name: string;
  fields: Array<{ key: string; type: string }>;
}): PageDoc {
  const title = titleKey(opts.fields);
  const image = imageKey(opts.fields);
  const body = bodyKey(opts.fields);
  const intro = section([
    block(
      "Text",
      { colStart: 2, colEnd: 18, rowStart: 2, rowEnd: 5 },
      {
        html: `<h1>${escapeHtml(opts.name)}</h1><p>Published entries appear below.</p>`,
        align: "left",
        textRole: "display",
      }
    ),
  ]);
  const cardBlocks: Block[] = [];
  if (image) {
    cardBlocks.push(
      block(
        "Image",
        { colStart: 2, colEnd: 9, rowStart: 2, rowEnd: 8 },
        { src: `{{${image}}}`, alt: `{{${title}}}`, blockFit: "fit", layout: "inline" },
        image
      )
    );
  }
  const textCol = image ? 10 : 2;
  cardBlocks.push(
    block(
      "Text",
      { colStart: textCol, colEnd: 22, rowStart: 2, rowEnd: 4 },
      { html: `<h2>{{${title}}}</h2>`, textRole: "heading" },
      title
    )
  );
  if (body) {
    cardBlocks.push(
      block(
        "Text",
        { colStart: textCol, colEnd: 22, rowStart: 4, rowEnd: 7 },
        { html: `<p>{{${body}}}</p>`, textRole: "body" },
        body
      )
    );
  }
  cardBlocks.push(
    block(
      "Button",
      { colStart: textCol, colEnd: textCol + 5, rowStart: 7, rowEnd: 9 },
      { label: "View", href: "{{itemHref}}", variant: "solid" }
    )
  );
  const card = section(cardBlocks, { dataRepeat: "items", minHeight: "360px" });
  return {
    schemaVersion: 3,
    pages: [intro, card],
    templateSurfaceDefaults: { preset: "transparent", borderMode: "none" },
    templateAnimationDefaults: { entrancePreset: "none" },
    timelines: [],
  };
}

export function collectionItemDocument(opts: {
  name: string;
  fields: Array<{ key: string; type: string }>;
}): PageDoc {
  const title = titleKey(opts.fields);
  const image = imageKey(opts.fields);
  const body = bodyKey(opts.fields);
  const blocks: Block[] = [
    block(
      "Text",
      { colStart: 2, colEnd: 16, rowStart: 2, rowEnd: 4 },
      { html: `<h1>{{${title}}}</h1>`, textRole: "display" },
      title
    ),
  ];
  if (image) {
    blocks.push(
      block(
        "Image",
        { colStart: 2, colEnd: 14, rowStart: 4, rowEnd: 12 },
        { src: `{{${image}}}`, alt: `{{${title}}}`, blockFit: "fit", layout: "inline" },
        image
      )
    );
  }
  if (body) {
    blocks.push(
      block(
        "Text",
        { colStart: image ? 15 : 2, colEnd: 24, rowStart: 4, rowEnd: 12 },
        { html: `<p>{{${body}}}</p>`, textRole: "body", fluidTextMeasure: true },
        body
      )
    );
  }
  return {
    schemaVersion: 3,
    pages: [section(blocks, { minHeight: "640px" })],
    templateSurfaceDefaults: { preset: "transparent", borderMode: "none" },
    templateAnimationDefaults: { entrancePreset: "none" },
    timelines: [],
  };
}

export function fallbackItemDocument(data: CollectionItemData, itemHref: string): PageDoc {
  const title = lookup(data, "title", itemHref) || lookup(data, "name", itemHref) || "Item";
  const body =
    lookup(data, "body", itemHref) ||
    lookup(data, "description", itemHref) ||
    lookup(data, "summary", itemHref) ||
    lookup(data, "bio", itemHref) ||
    lookup(data, "quote", itemHref);
  const image =
    lookup(data, "cover", itemHref) ||
    lookup(data, "photo", itemHref) ||
    lookup(data, "avatar", itemHref) ||
    lookup(data, "gallery.0", itemHref);
  const blocks: Block[] = [
    block(
      "Text",
      { colStart: 2, colEnd: 20, rowStart: 2, rowEnd: 4 },
      { html: `<h1>${escapeHtml(title)}</h1>`, textRole: "display" }
    ),
  ];
  if (image) {
    blocks.push(
      block(
        "Image",
        { colStart: 2, colEnd: 14, rowStart: 4, rowEnd: 12 },
        { src: image, alt: title, blockFit: "fit", layout: "inline" }
      )
    );
  }
  if (body) {
    blocks.push(
      block(
        "Text",
        { colStart: image ? 15 : 2, colEnd: 24, rowStart: 4, rowEnd: 12 },
        { html: `<p>${escapeHtml(body)}</p>`, textRole: "body", fluidTextMeasure: true }
      )
    );
  }
  return {
    schemaVersion: 3,
    pages: [section(blocks, { minHeight: "640px" })],
    templateSurfaceDefaults: { preset: "transparent", borderMode: "none" },
    templateAnimationDefaults: { entrancePreset: "none" },
    timelines: [],
  };
}

export function itemDisplayName(data: CollectionItemData, slug: string): string {
  const raw = data.title ?? data.name ?? data.author ?? data.quote ?? slug;
  return String(raw || slug).slice(0, 120);
}

export function itemDescription(data: CollectionItemData): string {
  const raw = data.summary ?? data.description ?? data.body ?? data.bio ?? data.quote ?? "";
  return String(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function itemImage(data: CollectionItemData): string {
  return (
    lookup(data, "cover", "") ||
    lookup(data, "photo", "") ||
    lookup(data, "avatar", "") ||
    lookup(data, "gallery.0", "") ||
    lookup(data, "image", "")
  );
}
