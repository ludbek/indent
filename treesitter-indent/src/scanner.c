#include "tree_sitter/parser.h"
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

// External scanner for Indent Markup Language.
//
// Responsibilities (mirrors indent-parser/src/tokenizer.ts):
//   - Measure indentation in leading 4-space groups and emit NEWLINE /
//     INDENT / DEDENT tokens accordingly (Python/YAML-style layout).
//   - Skip blank lines and full-line `;` comments as part of the NEWLINE
//     token, so they never affect indentation or produce their own tokens.
//
// Backslash line-continuation is *not* handled here: it's modeled as a
// plain `extras` token in grammar.js (`\` + newline + following
// whitespace), since anything the external scanner consumes without
// producing a real token gets silently discarded by tree-sitter.
//
// Design (standard for indentation-sensitive tree-sitter grammars, as in
// tree-sitter-python/tree-sitter-yaml):
//   - NEWLINE is requested by the grammar right after a statement's
//     attributes. It consumes the line ending plus any run of trailing
//     blank/comment lines, leaving the lexer positioned at the start of
//     the next real content line's leading whitespace (or at EOF).
//   - INDENT/DEDENT are requested when the grammar is deciding whether to
//     open, continue, or close a `block`. At that point the lexer is
//     always sitting at the start of a real line's leading whitespace (or
//     EOF), so indentation depth can be measured directly.
//   - INDENT consumes the line's leading whitespace (so the following
//     `type` token starts clean). DEDENT is zero-width and may be emitted
//     repeatedly to pop multiple levels; the final matching depth's
//     leading whitespace is left for the grammar's `extras` (`/[ \t]/`) to
//     consume normally.

enum TokenType {
  NEWLINE,
  INDENT,
  DEDENT,
};

typedef struct {
  // Stack of indent levels, measured in 4-space groups. Always starts at
  // [0] (top-level/document depth).
  uint32_t *stack;
  uint32_t size;
  uint32_t capacity;
  // Indent depth (4-space groups) measured for the next real content line
  // by the most recent NEWLINE token, consumed by the immediately
  // following INDENT/DEDENT decision(s). Valid only in that narrow window;
  // harmless to serialize since GLR may snapshot/restore state between
  // those two calls.
  uint32_t pending_depth;
  bool has_pending_depth;
} Scanner;

static void stack_push(Scanner *s, uint32_t value) {
  if (s->size == s->capacity) {
    s->capacity = s->capacity == 0 ? 8 : s->capacity * 2;
    s->stack = realloc(s->stack, s->capacity * sizeof(uint32_t));
  }
  s->stack[s->size++] = value;
}

static uint32_t stack_top(const Scanner *s) {
  return s->stack[s->size - 1];
}

void *tree_sitter_indent_external_scanner_create() {
  Scanner *s = calloc(1, sizeof(Scanner));
  stack_push(s, 0);
  return s;
}

void tree_sitter_indent_external_scanner_destroy(void *payload) {
  Scanner *s = (Scanner *)payload;
  free(s->stack);
  free(s);
}

unsigned tree_sitter_indent_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  unsigned size = 0;
  uint32_t count = s->size;
  uint32_t max_count = (uint32_t)((TREE_SITTER_SERIALIZATION_BUFFER_SIZE - sizeof(uint32_t) * 3) / sizeof(uint32_t));
  if (count > max_count) count = max_count;
  memcpy(buffer + size, &count, sizeof(uint32_t));
  size += sizeof(uint32_t);
  memcpy(buffer + size, s->stack, count * sizeof(uint32_t));
  size += count * sizeof(uint32_t);
  uint32_t has_pending = s->has_pending_depth ? 1 : 0;
  memcpy(buffer + size, &has_pending, sizeof(uint32_t));
  size += sizeof(uint32_t);
  memcpy(buffer + size, &s->pending_depth, sizeof(uint32_t));
  size += sizeof(uint32_t);
  return size;
}

void tree_sitter_indent_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;
  s->size = 0;
  s->pending_depth = 0;
  s->has_pending_depth = false;
  if (length == 0) {
    stack_push(s, 0);
    return;
  }
  uint32_t count = 0;
  memcpy(&count, buffer, sizeof(uint32_t));
  unsigned offset = sizeof(uint32_t);
  for (uint32_t i = 0; i < count; i++) {
    uint32_t value = 0;
    memcpy(&value, buffer + offset, sizeof(uint32_t));
    offset += sizeof(uint32_t);
    stack_push(s, value);
  }
  uint32_t has_pending = 0;
  memcpy(&has_pending, buffer + offset, sizeof(uint32_t));
  offset += sizeof(uint32_t);
  s->has_pending_depth = has_pending != 0;
  memcpy(&s->pending_depth, buffer + offset, sizeof(uint32_t));
  offset += sizeof(uint32_t);
}

static bool is_eof(TSLexer *lexer) {
  return lexer->eof(lexer);
}


// Skips a run of blank lines and full-line `;` comment lines, leaving the
// lexer positioned at the start of the next real content line (or EOF).
// Returns the leading-space count of that final real content line (0 if
// EOF or a stray tab was encountered instead).
static uint32_t skip_blank_and_comment_lines(TSLexer *lexer) {
  for (;;) {
    // Commit everything consumed so far (i.e. up to the start of this
    // candidate line) as the real token boundary *before* speculatively
    // reading ahead -- including before checking for EOF, since a blank
    // line consumed in the *previous* iteration only becomes "real" once
    // we mark_end() past it here.  If this line turns out to be real
    // content, we simply return without calling mark_end() again, so the
    // speculative reads below are discarded and the next token starts
    // right here, at the beginning of this line's leading whitespace.
    lexer->mark_end(lexer);

    if (is_eof(lexer)) return 0;

    uint32_t spaces = 0;
    while (lexer->lookahead == ' ') {
      spaces++;
      lexer->advance(lexer, false);
    }

    if (lexer->lookahead == '\t') {
      // Stray tab: not our concern here, let downstream handle/error.
      return 0;
    }

    if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
      // Blank line.
      if (lexer->lookahead == '\r') lexer->advance(lexer, false);
      if (lexer->lookahead == '\n') lexer->advance(lexer, false);
      continue;
    }

    if (lexer->lookahead == ';') {
      // Full-line `;` comment: consume to end-of-line and continue.
      while (!is_eof(lexer) && lexer->lookahead != '\n' && lexer->lookahead != '\r') {
        lexer->advance(lexer, false);
      }
      if (lexer->lookahead == '\r') lexer->advance(lexer, false);
      if (lexer->lookahead == '\n') lexer->advance(lexer, false);
      continue;
    }

    if (is_eof(lexer)) return spaces;

    // Real content line.
    return spaces;
  }
}

// Counts (without permanently committing) the leading space run at the
// current position, returning the count. Caller is responsible for
// mark_end() semantics.
static uint32_t count_leading_spaces(TSLexer *lexer) {
  uint32_t count = 0;
  while (lexer->lookahead == ' ') {
    count++;
    lexer->advance(lexer, false);
  }
  return count;
}

bool tree_sitter_indent_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  bool want_newline = valid_symbols[NEWLINE];
  bool want_indent = valid_symbols[INDENT];
  bool want_dedent = valid_symbols[DEDENT];

  if (want_newline) {
    // NEWLINE is often *also* offered as an alternative to lexing another
    // attribute (whenever the grammar could go either way at this point),
    // so we must first confirm we are actually at end-of-line (ignoring
    // inline whitespace and trailing comments) before committing to
    // anything. If real content remains on the line, bail out so the
    // internal tokenizer can lex the next attribute. (Backslash
    // line-continuation is handled separately as a grammar `extras` token,
    // so a literal '\' reaching this point is always ordinary content.)
    for (;;) {
      while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        lexer->advance(lexer, false);
      }

      if (lexer->lookahead == ';') {
        // A trailing `;` comment: consume it to end-of-line so the NEWLINE
        // token swallows it. Comments no longer collide with `/`-prefixed
        // positional ref values (`/...` / `//...`), which are ordinary
        // content and fall through to the bail-out below, letting the
        // internal lexer recognize them as `xpath` tokens.
        while (!is_eof(lexer) && lexer->lookahead != '\n' && lexer->lookahead != '\r') {
          lexer->advance(lexer, false);
        }
        break;
      }

      if (is_eof(lexer)) break;
      if (lexer->lookahead == '\n' || lexer->lookahead == '\r') break;

      // Real content remains: not at end-of-line yet.
      return false;
    }

    if (!is_eof(lexer)) {
      if (lexer->lookahead == '\r') lexer->advance(lexer, false);
      if (lexer->lookahead == '\n') lexer->advance(lexer, false);
    }
    // Measure the next real content line's indentation depth *now*, while
    // skip_blank_and_comment_lines is still looking at the real,
    // un-tampered-with source (before the grammar's plain `/[ \t]/` extra
    // gets a chance to run at this position and eat the very whitespace
    // we'd otherwise need to re-measure on a later, separate scan() call
    // for INDENT/DEDENT). The returned space count reflects what that
    // function already walked past internally while peeking ahead.
    uint32_t next_line_spaces = skip_blank_and_comment_lines(lexer);
    s->pending_depth = next_line_spaces / 4;
    s->has_pending_depth = true;
    lexer->result_symbol = NEWLINE;
    return true;
  }

  if (want_indent || want_dedent) {
    // Use the depth measured by the preceding NEWLINE token rather than
    // re-measuring leading whitespace here: by this point the grammar's
    // `/[ \t]/` extra may already have consumed it.
    uint32_t depth = s->has_pending_depth ? s->pending_depth : 0;
    uint32_t top = stack_top(s);

    if (depth > top && want_indent) {
      stack_push(s, depth);
      // Consume any leading whitespace still present (harmless no-op if
      // extras already ate it) so the `type` token starts clean.
      if (!is_eof(lexer)) count_leading_spaces(lexer);
      lexer->mark_end(lexer);
      lexer->result_symbol = INDENT;
      return true;
    }

    if (depth < top && want_dedent) {
      s->size--;
      // Zero-width: intentionally do not consume/commit anything.
      lexer->result_symbol = DEDENT;
      return true;
    }

    return false;
  }

  return false;
}
