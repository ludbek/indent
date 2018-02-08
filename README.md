heading '
  xml-lite
'

table [strip = true]
  heading 'sn, name, location'
  body '
    1, suren, thimi
    2, elina, emadol
  '

image 'Greetings' 'http://hellothere'

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

? aquintine on block concept


[
  :user [:id > 3] [
    :id
    :name
    :location [:id = 1] [
      :id
      :name
    ]
  ]
]


