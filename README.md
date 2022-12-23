```
- implicit types, strings by default, unless number or boolean
- to represent a number or boolean as string wrap it with ""

user [type = resource] {
  id int
  name string
  email string (validation: email)
  password string
}

create-arg [type = resource] {
  name string
  email string
  location [optional = true, default = ktm] string
}

resources {
  user {
    id int
    name string
  }
  create-arg {
    name string
    email string
  }
}

create [type = action] {
  arg {
    name string
    email string
    location [default = ktm] string
  }
}

actions {
  creae {
    arg [type = resource ] {
      name string
      email string
      location [default = ktm] string
    }
  }
}

create [type action]:
  arg:
    name: string
    email: string
    location [default ktm]: string

actions:
  create:
    arg [type resource]:
      name: string
      email: string
      location [default ktm]: string
      
// put these in prelude of a parser
int "string"
string "string"

user [type "resource"]
  id int
  name string
  location [default "ktm", optional true] string

create [type "action"]
  arg
    name string
    email string
    location [default "ktm"] string
  res user
      
actions
  create
    arg
      name string
      email string
      location [default ktm] string
```
- how to support array?
- - if children of an element if of same type, they are converted to array? e.g. shows {movie {}, movie{}}


- aim
- - lml to json or xml
- - lml is a sub set of lisp
