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
  name 'string'
  email 'string'
  location (optional true, default 'ktm') 'string'
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
