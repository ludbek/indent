/**
 * @file Tree-sitter grammar for Indent Markup Language (.inml) used by diagram-app
 * @author Suren
 * @license MIT
 *
 * Grammar shape (mirrors indent-parser/src/tokenizer.ts + parser.ts):
 *
 *   statement := <type> (key=value)*  NEWLINE (INDENT statement+ DEDENT)?
 *   value     := string | number | boolean
 *
 * There is no special-cased "edge"/"include"/"reference" concept at the
 * grammar level -- every line is just a `type` keyword plus zero or more
 * `key=value` attributes, optionally followed by a deeper-indented block of
 * child statements. Meaning is assigned entirely by downstream consumers.
 *
 * Indentation (4-space groups, NEWLINE/INDENT/DEDENT tokens) is handled by
 * the external scanner in src/scanner.c, since indentation-sensitivity is
 * not context-free. Backslash line-continuation is modeled as an invisible
 * `extras` token (a trailing `\` plus the following line's leading
 * whitespace), so it simply disappears between two ordinary tokens without
 * needing any external-scanner involvement.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: "indent",

  externals: $ => [
    $._newline,
    $._indent,
    $._dedent,
  ],

  extras: $ => [
    // Only inline (non-leading) whitespace and comments are "free" extras;
    // leading-of-line whitespace is consumed by the external scanner while
    // computing indentation.
    /[ \t]/,
    $.comment,
    // Backslash line-continuation: joins the current line with the next
    // physical line. The next line's leading whitespace is swallowed here
    // too, since a continuation line's indentation is not meaningful.
    token(seq("\\", /\r?\n/, /[ \t]*/)),
  ],

  conflicts: $ => [],

  rules: {
    // A leading `_newline` handles any blank lines/comments that appear
    // before the very first statement (the external scanner's NEWLINE
    // branch already treats "already at end-of-line" as consumable, so
    // this reuses the same blank/comment-skipping logic for free).
    document: $ => seq(optional($._newline), repeat($.statement)),

    statement: $ => seq(
      field("type", $.type),
      optional(field("value", $.positional_value)),
      repeat(field("attribute", $.attribute)),
      $._newline,
      optional($.block),
    ),

    block: $ => seq(
      $._indent,
      repeat1($.statement),
      $._dedent,
    ),

    // Bareword keyword/tag, e.g. "org", "service", "->", "=>" -- OR a
    // built-in directive kind starting with "!" (e.g. "!include",
    // "!schema"). Mirrors tokenizer.ts's KIND_NAME_PATTERN:
    // - Must start with a letter, underscore, one of `- = < >` (so edge
    //   markers "->"/"=>" remain valid), or a leading "!" for a built-in
    //   directive, followed by any number of letters, digits, underscores,
    //   hyphens, or `< = >`.
    // Still excludes whitespace and '\' for line-continuation safety.
    type: $ => token(/!?[-_=<>A-Za-z][-_=<>A-Za-z0-9]*/),

    positional_value: $ => choice($.string, $.number, $.boolean, $.xpath),

    attribute: $ => seq(
      field("name", $.attribute_name),
      "=",
      field("value", $.value),
    ),

    // Must start with a letter or underscore, followed by letters, digits,
    // underscores, or hyphens (mirrors tokenizer.ts's ATTR_NAME_PATTERN) --
    // so e.g. `background-color` is valid but `123` or `1abc` are not.
    attribute_name: $ => token(prec(-1, /[A-Za-z_][A-Za-z0-9_-]*/)),

    value: $ => choice($.string, $.number, $.boolean, $.xpath),

    // A ref value's body may contain a quoted predicate literal (e.g.
    // `service[.="Auth Service"]`), which can itself contain spaces -- so
    // unlike a bare non-whitespace run, we must treat a `"..."` span (with
    // `\"` escapes) as a single atomic unit that can swallow embedded
    // spaces, while still stopping at real unquoted whitespace/backslash
    // outside of any quotes.
    //
    // Only the `/` (absolute) and `//` (descendant) prefixes are accepted,
    // matching the actual ref dialect exactly (indent-parser's
    // tokenizer.ts `REF_SEPARATOR`) -- deliberately NOT `./`/`../`
    // (relative/parent axes, unsupported) and NOT a bareword-anchored
    // form (`[A-Za-z_*@]...`, old dialect's wildcard/attribute-axis/bare
    // relative forms, also unsupported). Dropping the bareword branch is
    // also required for correctness: `positional_value` (below) accepts
    // `$.xpath` too, and a bareword-anchored xpath token would otherwise
    // tie for longest match against `attribute_name` on ordinary
    // `name=value` attribute lines, misparsing them as a positional ref.
    xpath: $ => token(seq(
      choice('/', '//'),
      repeat(choice(
        /[^ \t\r\n\\"]/,
        seq('"', repeat(choice(/[^"\\\r\n]/, /\\./)), '"'),
      ))
    )),

    string: $ => token(seq(
      '"',
      repeat(choice(
        /[^"\\\r\n]/,
        /\\./,
      )),
      '"',
    )),

    number: $ => /-?\d+(\.\d+)?/,

    boolean: $ => choice("true", "false"),

    comment: $ => token(seq(";", /[^\r\n]*/)),
  },
});
