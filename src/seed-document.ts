/** Minimal valid PageDocumentV3 for a new home page (Text block + sample timeline). */
export function blankHomeDocumentJson(): string {
  const sectionId = crypto.randomUUID();
  const blockId = crypto.randomUUID();
  const timelineId = "landing-intro";
  const doc = {
    schemaVersion: 3,
    pages: [
      {
        id: sectionId,
        settings: {
          sectionType: "lava",
          minHeight: "480px",
          fullWidth: false,
          backgroundColor: "#ffffff",
        },
        blocks: [
          {
            id: blockId,
            type: "Text",
            placement: {
              desktop: { colStart: 2, colEnd: 14, rowStart: 2, rowEnd: 5 },
              gridColumn: "2 / 14",
              gridRow: "2 / 5",
              zIndex: 1,
            },
            props: {
              html: "<h1>Welcome</h1><p>Edit this site from <strong>/edit</strong>. Select this block and open Motion to scrub the sample timeline — or ask the Agent to design the page.</p>",
              align: "left",
              textRole: "display",
            },
            links: [
              {
                channel: "opacity",
                input: { kind: "timeline", timelineId },
                from: 0,
                to: 1,
              },
            ],
          },
        ],
      },
    ],
    templateSurfaceDefaults: {},
    templateAnimationDefaults: { entrancePreset: "none" },
    timelines: [
      {
        id: timelineId,
        name: "Landing intro",
        duration: 1.2,
        scrub: false,
        tracks: [
          {
            blockId,
            channel: "opacity",
            keyframes: [
              { t: 0, value: 0 },
              { t: 1, value: 1 },
            ],
          },
          {
            blockId,
            channel: "y",
            keyframes: [
              { t: 0, value: 24 },
              { t: 1, value: 0, easing: "power2.out" },
            ],
          },
        ],
      },
    ],
  };
  return JSON.stringify(doc);
}
