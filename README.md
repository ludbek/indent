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
      
create [type action]
  arg
    name string
    email string
    location [default ktm] string
  res
    id int
    name string
    email string
    location string
      
actions
  create
    arg [type resource]
      name string
      email string
      location [default ktm] string
```
