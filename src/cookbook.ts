/** Motion cookbook — self-describing recipes for MCP agents. */

export const MOTION_COOKBOOK = {
  version: 1,
  channels: [
    "x",
    "y",
    "z",
    "opacity",
    "rotate",
    "rotateX",
    "rotateY",
    "scale",
    "zIndex",
  ],
  instructions: [
    "Prefer atomic ops (add_track, set_keyframe, adjust_timing, add_pin, add_motion_link).",
    "Never invent channel names outside the channels list.",
    "Call preview_ops before apply_ops for multi-op or destructive changes.",
    "Use apply_page_document only when the user explicitly asks to rebuild the whole page.",
  ],
  recipes: {
    "parallax-slow": {
      summary: "Link block Y to page scroll (slow parallax).",
      ops: [
        {
          op: "add_motion_link",
          sectionId: "<sectionId>",
          blockId: "<blockId>",
          channel: "y",
          input: { kind: "scroll-page", from: 0, to: 1 },
          from: 0,
          to: 120,
          easing: "none",
        },
      ],
    },
    "parallax-fast": {
      summary: "Faster Y parallax on scroll.",
      ops: [
        {
          op: "add_motion_link",
          sectionId: "<sectionId>",
          blockId: "<blockId>",
          channel: "y",
          input: { kind: "scroll-page", from: 0, to: 1 },
          from: 0,
          to: 280,
          easing: "none",
        },
      ],
    },
    "pin-hero": {
      summary: "Pin a section while scroll continues.",
      ops: [
        {
          op: "add_pin",
          sectionId: "<sectionId>",
          start: "top top",
          end: "+=100%",
          pinSpacing: true,
        },
      ],
    },
    "hold-block": {
      summary: "Pin one block; siblings can animate past via Y/X tracks.",
      ops: [
        {
          op: "add_pin",
          blockId: "<blockId>",
          start: "top center",
          end: "+=60%",
          pinSpacing: true,
        },
      ],
    },
    "fade-in-scrub": {
      summary: "Opacity 0→1 on a scroll-scrubbed timeline.",
      ops: [
        {
          op: "add_timeline",
          name: "Fade in",
          duration: 1,
          scrub: true,
        },
        {
          op: "add_track",
          timelineId: "<timelineId from add_timeline>",
          blockId: "<blockId>",
          channel: "opacity",
          from: 0,
          to: 1,
        },
      ],
    },
    "explode-gallery-scroll": {
      summary: "Stagger scale+opacity+y on image blocks as the section scrolls (product explode).",
      ops: [
        { op: "add_timeline", name: "Gallery explode", duration: 1.2, scrub: true },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<imageBlockId>",
          channel: "scale",
          from: 0.85,
          to: 1,
        },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<imageBlockId>",
          channel: "opacity",
          from: 0,
          to: 1,
        },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<imageBlockId>",
          channel: "y",
          from: 40,
          to: 0,
        },
      ],
    },
    "scene3d-turntable-scrub": {
      summary: "Rotate a Scene3D block on scroll scrub (product turntable).",
      ops: [
        { op: "add_timeline", name: "3D turntable", duration: 1, scrub: true },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<scene3dBlockId>",
          channel: "rotateY",
          from: -0.4,
          to: 0.4,
        },
      ],
    },
    "scene3d-float-in": {
      summary: "Scene3D floats up and fades in on enter.",
      ops: [
        {
          op: "add_timeline",
          name: "3D float in",
          duration: 1,
          scrub: false,
          playback: "play-on-enter",
        },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<scene3dBlockId>",
          channel: "y",
          from: 48,
          to: 0,
        },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<scene3dBlockId>",
          channel: "opacity",
          from: 0,
          to: 1,
        },
      ],
    },
    "ribbon-enter": {
      summary: "Staggered X enter + zIndex mid-scroll (repeat add_track per block).",
      ops: [
        { op: "add_timeline", name: "Ribbon", duration: 1.5, scrub: true },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<blockIdA>",
          channel: "x",
          from: -80,
          to: 0,
        },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<blockIdB>",
          channel: "x",
          from: 80,
          to: 0,
        },
        {
          op: "set_keyframe",
          timelineId: "<timelineId>",
          blockId: "<blockIdA>",
          channel: "zIndex",
          t: 0.5,
          value: 20,
        },
      ],
    },
    "image-cutout": {
      summary: "Strip Image frame/shadow/border for transparent PNG cutouts.",
      ops: [
        {
          op: "set_image_chrome",
          sectionId: "<sectionId>",
          blockId: "<blockId>",
          chrome: "cutout",
        },
        {
          op: "set_surface_defaults",
          preset: "transparent",
          borderMode: "none",
        },
      ],
    },
    "spin-stagger": {
      summary: "Staggered rotate 0→720 spin on scrub timeline (repeat set_keyframe per block).",
      ops: [
        { op: "add_timeline", name: "Spin", duration: 2, scrub: true },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<blockId>",
          channel: "rotate",
          from: 0,
          to: 720,
        },
      ],
    },
    "play-on-enter": {
      summary: "Timeline plays fully once when the first block enters the viewport.",
      ops: [
        {
          op: "update_timeline",
          timelineId: "<timelineId>",
          playback: "play-on-enter",
          scrollStart: "top 80%",
          duration: 1.5,
        },
      ],
    },
    "timed-hero": {
      summary: "Page-load hero: wait delayMs then play for duration (no scroll).",
      ops: [
        {
          op: "add_timeline",
          name: "Hero intro",
          playback: "timed",
          delayMs: 400,
          duration: 1.2,
        },
        {
          op: "add_track",
          timelineId: "<timelineId>",
          blockId: "<blockId>",
          channel: "opacity",
          from: 0,
          to: 1,
        },
      ],
    },
  },
} as const;

export const MOTION_SCHEMA_DIGEST = {
  timelines: {
    id: "string",
    name: "string",
    duration: "number seconds",
    playback: "scrub | play-on-enter | timed | manual",
    scrub: "boolean — legacy alias for playback=scrub",
    scrollStart: "ScrollTrigger start",
    scrollEnd: "ScrollTrigger end (scrub)",
    delayMs: "number — timed playback delay before play",
    repeat: "number — GSAP repeat; -1 = infinite (timed / play-on-enter / manual)",
    tracks: [
      {
        blockId: "uuid",
        channel: "MotionChannel",
        keyframes: [{ t: "0..1", value: "number|string", easing: "optional" }],
      },
    ],
  },
  pins: [
    {
      blockId: "uuid?",
      sectionId: "uuid?",
      start: "ScrollTrigger start",
      end: "ScrollTrigger end",
      pinSpacing: "boolean",
    },
  ],
  links: {
    channel: "MotionChannel",
    input: "scroll-page | scroll-section | timeline | hover | inView",
    from: "number|string",
    to: "number|string",
  },
};
