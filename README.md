heading '
  xml-lite
'

table [strip = true]
  heading 'sn, name, location'
  body '
    1, suren, thimi
    2, elina, emadol
  '

link label: 'Greetings' to: 'http://hellothere'

- its lisp
- neutral characters (, =)
- everything is a function
- (multi)string delimiters ''
- \ continuation character
- python like white space sensitive
- by default every statement is list
-- starts with whitespace
-- ends at new line

- SUPPORT XML-LITE AS FIRST CLASS DATA STRUCTURE
{
  user (id > 3) {
    id,
    name,
    location (id = 1) {
      id,
      name
    }
  }
}

lisp + smalltalk

function is an object too.

A calls B, B class C, c class D -- D knows C called it, C knows B called it, B knows A called it.

Concept of owner. An object obeys its owner.

inline comment : or ` or , or .
