; Syntax highlighting queries for the Tree DSL.
;
; The grammar has no special-cased "edge"/"reference" concepts, so
; highlighting stays purely syntactic: the leading `type` keyword of every
; statement is highlighted uniformly (regardless of its value -- "org",
; "service", "->", "=>", "include" are all just barewords), attribute names
; are treated as properties, and values are colored by their literal kind.

(type) @keyword

(attribute_name) @property

(string) @string
(xpath) @string.special
(number) @number
(boolean) @boolean

(comment) @comment

"=" @operator
