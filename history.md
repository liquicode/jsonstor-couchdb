# jsonstor-couchdb
[`@liquicode/jsonstor-couchdb`](https://github.com/liquicode/jsonstor-couchdb)


# Project History


v0.2.0 (current)
---------------------------------------------------------------------

***First release.***

The adapter for Apache CouchDB, translating a criteria into a Mango selector. Tested on
  CouchDB 2.3 and 3.5.

- Built on `@liquicode/jsonstor` 0.2.0 and `@liquicode/jsongin` 0.2.0. A criteria the engine
  refuses is refused before the storage acts on it.
- An update which changes the identifier is refused, and `ReplaceOne` keeps it.
- The TLS setting is `Encrypt`.
- Declares Node.js `>=18.0.0` in `engines`.
