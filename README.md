```
- implicit types, values are either integer, boolean or else string
- support for importing another file
- use cases for this doc
  - schema definition
  - config definition
  - can be used to communicate between devices
- supports module system, a file name is a module name
  - refer to a module nodes by `./module/path.node-name.sub-node-name
- refer to nodes in current doc, node-name
- 'is a multiple string'
- this doc to xml or json

- todo
-- support array
-- how would one support enums?
-- support import? we might, imagine splitting files and connecting them all in top level doc

Aim
- markdown alternative for docs
- data serialization and eserialization just like xml

Mardown alternative
h1: Welcome to the green land
ol {
  li: apple
  li: banana
  li: pineapple
}
p {
  'hello there' // text node literal
  strong: 'suri meow' // inline text node literal
  'How are you?'
}

Serialization
user (type resource) {
  id 'int'
  name 'string'
  email (validation email) 'string'
  password 'string'
}

admin-user (type = resource, extends = user) {
  previliges []
}

create-arg (type = 'resource') {
  name: string
  email: string
  location (optional true, default 'ktm'): string
}

int 'int'
string 'string'

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

create (type = "action") {
  arg {
    name string,
    email string,
    location (default = "ktm") string,
  },
  res [user] // array of users
}

actions {
  create-user (
}
```

Finalized
'is a text literal' // can be used to chain multiple nodes
node: single text literal
{} is wraps child nodes
first word is a node
() is map

