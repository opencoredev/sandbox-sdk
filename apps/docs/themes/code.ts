/**
 * Shiki theme for code blocks, using the landing page's code colours
 * (apps/web/src/app/(home)/landing.module.css, the .tk* classes and --panel).
 */
import type { CodeTheme } from "blume/markdown";

export const sandboxDark = {
  name: "sandbox-dark",
  type: "dark",
  colors: {
    "editor.background": "#111214",
    "editor.foreground": "#ecebe8",
  },
  tokenColors: [
    { settings: { foreground: "#ecebe8" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#808289", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.control",
        "keyword.operator.new",
        "keyword.operator.expression",
        "variable.language",
      ],
      settings: { foreground: "#d8a35c" },
    },
    {
      scope: ["string", "string.template", "punctuation.definition.string", "markup.inline.raw", "string.regexp"],
      settings: { foreground: "#c9b58a" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: "#808289" },
    },
    {
      scope: ["punctuation", "meta.brace", "keyword.operator"],
      settings: { foreground: "#8d8e93" },
    },
  ],
} satisfies CodeTheme;
