'use strict';

const jsongin = require( '@liquicode/jsongin' );


//---------------------------------------------------------------------
// ***There is no driver, and that is the decision this adapter is built around.***
//
// CouchDB is HTTP and JSON with no wire protocol of its own, so a client library would buy
// conveniences which are CouchDB shaped and carry over to none of the other targets in this
// wave. ***Wave 3's new capability is reaching a storage over HTTP***, and writing that on
// Node's global `fetch` is what makes it reusable by the adapters which follow instead of
// hiding it inside one vendor's client.
//
// ***It costs nothing in reach.*** Global `fetch` arrived on by default in Node 18.0.0, which
// is below `jsonstor-redis` at 20 and well below `jsonstor-sqlite` at 22. An adapter's floor
// has never propagated to `jsongin` or `jsonstor`, which are measured to run on 10.4.1.
//
// See jsonx/.plans/wave-3-http-transport.md.


//---------------------------------------------------------------------
// ***A database is a collection, and `DatabaseName` names it.***
//
// CouchDB has no collections inside a database, so one of the two had to give. A database per
// collection is the idiomatic mapping and the honest one: `DropStorage` is a single `DELETE`
// which removes exactly this storage's documents, and a `_find` never walks a neighbour's.


//---------------------------------------------------------------------
// ***The database is an index over the document, not the document.***
//
// This is the shape the SQL adapters in this family already have, and it is here for the same
// reason. ***CouchDB requires a document identifier to be a string***, and a jsonstor `_id`
// may be a number - the shared inventory writes `{ _id: 1, item: null }`. A store whose
// documents must fit the medium's native shape cannot hold that.
//
// So the medium holds a ***key*** and the document travels in a ***payload***:
//
//     { _id:                 String( document[ IdField ] ),   the key
//       _rev:                ...,                             CouchDB's own
//       jsonstor_sequence:   '00001756...000042',             insertion order
//       jsonstor_document:   { ...the true document... } }    the payload
//
// ***The payload carries the true identifier with its true type***, which is `id_to_key()`
// in `jsonstor-sqlite` word for word - a TEXT key takes `String()` so that the by-id
// statements compare like with like, and the payload is where the value really lives. It is
// the configuration the inventory describes as *the only one which answers every question the
// other adapters answer*: an absent field stays apart from one holding null, a number does not
// come back a string, and an object keeps its field order.
//
// ***Setting `PayloadField` to an empty string gives the other configuration***, where the
// document is the CouchDB document. That is what an existing CouchDB database looks like, and
// it is the configuration to use when reading one. It cannot store an identifier which is not
// a string, and says so by name rather than storing something else.


//---------------------------------------------------------------------
// ***Insertion order is a field, and it is never part of a document.***
//
// A `_find` answers in the order of whichever index it used, and CouchDB has no row identifier
// which survives an update - so the order a collection reads back in has to be written down.
// ***This is `jsonstor-mssql`'s `_seq` column***, in CouchDB's vocabulary: written once on
// insert, left alone by every update, and removed before a document reaches a caller.
//
// A database you bring yourself has no such field, and is read in the server's own `_id`
// order. That is the same answer `jsonstor-mssql` gives for a table it did not create.
const SEQUENCE_FIELD = 'jsonstor_sequence';


//---------------------------------------------------------------------
// ***`_find` answers 25 documents when nobody says otherwise.***
//
// That default is the most dangerous thing in this API: a collection larger than one page
// comes back ***short and successful***, which is a plausible answer rather than a failure -
// the exact shape of the `update_catalog` defect `004) Unreachable Storage Tests` exists to
// catch. So every read pages by `bookmark` until a page comes back short, and no read ever
// relies on a limit being large enough.
const FIND_PAGE_SIZE = 1000;


//---------------------------------------------------------------------
// ***How long to wait for a server which is not refusing but is not answering either.***
//
// A closed port answers `ECONNREFUSED` at once and needs no timeout; an address which drops
// the packets answers nothing, and that is the case this bounds. `jsonstor-redis` bounds the
// same case with the same number, in its driver's vocabulary rather than in `fetch`'s.
const REQUEST_TIMEOUT_MS = 5000;


//---------------------------------------------------------------------
// ***What CouchDB does with each jsongin query operator, measured on two live servers.***
//
// Measured against CouchDB 2.3.1 and 3.5.2 on 2026-09-02, over one corpus, against jsongin's
// own answer on the same documents. ***The two servers agreed on all 45 probes***, which is
// why this package has one prime rather than two.
//
// ***This table lowers `MangoExpression`'s ceiling and can never raise it.*** Only the
// operators which differ from that ceiling are named; everything absent from here keeps the
// fidelity the translator measured against MongoDB.
const OPERATOR_FIDELITIES = {

	// ***Refused by the server outright***, with the same `invalid_operator` wording on both.
	// `$expr` and the four bitwise operators are MongoDB's and Mango has never had them.
	'$expr': 'dropped',
	'$bitsAllSet': 'dropped',
	'$bitsAllClear': 'dropped',
	'$bitsAnySet': 'dropped',
	'$bitsAnyClear': 'dropped',

	// ***Refused although they constrain nothing.*** MongoDB accepts `$comment` and ignores
	// it; CouchDB refuses it by name. `$sampleRate` is the same story, and dropping it is
	// also the only correct answer for it - see `MangoExpression`, where re-checking a sample
	// is explained as the one narrowing a fidelity must never allow.
	'$comment': 'dropped',
	'$sampleRate': 'dropped',

	// ***Accepted, and it narrows, and there is no repair for this one.***
	//
	// `$nor` has the same cause as the three negations the repair covers: CouchDB answers a
	// negation only over the documents which hold the field, and jsongin returns the ones
	// which lack it too. It stays dropped because it is ***not scoped to a field***: the
	// repair offers the absence of one field beside the negation, and `$nor` may name several
	// or none. See jsonx/.plans/wave-3-http-transport.md.
	'$nor': 'dropped',

	// ***Broadening: rendered, and the residual still decides.*** Each was measured to admit
	// documents the criteria rejects and never to reject one the criteria admits, which is
	// the bargain every SQL adapter in this family already makes.
	//
	// The three negations are broadening rather than exact because a negation against a field
	// holding an ***array*** disagrees for the same reason `$eq` does, below - and broadening
	// costs a document read where exactness would have cost a row.
	'$ne': 'broadening',
	'$nin': 'broadening',
	'$elemMatch': 'broadening',

	// ***`$eq` and the implicit form are exact because the element test is rendered beside
	// them.***
	//
	// ***CouchDB's Mango has no implicit array element matching and MongoDB's query language
	// is built on it.*** `{ tags: 'B' }` asks jsongin and MongoDB whether `tags` is 'B' ***or
	// contains it***; CouchDB asks only the first, so a document whose `tags` is
	// `[ 'A', 'B', 'C' ]` was being dropped. ***A criteria cannot say whether a field holds an
	// array***, so this is not decided by the operand - it is asked of every equality, the way
	// `ExcludesArrayElements` declares below.
	//
	// Measured on both servers 2026-09-03: the repaired rendering agrees with jsongin exactly,
	// and rewriting the implicit form to an explicit `$eq` fixes an object operand at the same
	// time - `{ o: { n: 3.14 } }` reaches CouchDB as a sub-selector and broadens, while
	// `{ o: { $eq: { n: 3.14 } } }` is exact.

	'$all': 'dropped',
	'$type': 'dropped',

	// ***The four comparisons and `$in` are rendered, and what changed to allow it is the
	// translator rather than the server.***
	//
	// They were dropped because ***one shape of operand narrows***: a `null` operand makes
	// `$gte` and `$lte` answer only over the documents which hold the field, and an `$in`
	// holding `null` does the same. ***A fidelity read from the operator's name alone cannot
	// say that***, so all five were dropped for every operand to buy the one which narrows.
	// `MangoExpression` reads the operand now and each of these carries whichever repair its
	// operand asks for.
	//
	// Measured 2026-09-03 over one corpus against both servers and against `jsongin`, four
	// renderings of each probe, and ***the two servers agreed on every cell***:
	//
	//   against a number,      broadening. The server compares across types by its own
	//   a string, a boolean    collation, which admits documents `jsongin` rejects - a string
	//                          is not less than 5 to `jsongin` and is to CouchDB - and never
	//                          the reverse.
	//   `$lt` and `$lte`       narrow without the element test: a field holding `[ 1, 9 ]` is
	//                          below 5 to `jsongin` and is not to the server. Repaired, they
	//                          broaden like the rest. `$gt` and `$gte` did not narrow on this
	//                          corpus and carry the test on the same reasoning, measured to
	//                          cost nothing.
	//   a `null` operand       narrows, and it is the missing field again rather than anything
	//                          new - the same cause as `$ne`, repaired the same way.
	//   `$in`                  exact in every probe put to it, including against an array,
	//                          which is the one place CouchDB reaches an array's elements
	//                          without being asked. ***Declared broadening rather than exact***
	//                          because that exactness rests on four probes and not on the
	//                          inventory as well, and this table is the intersection of the two.
	'$gt': 'broadening',
	'$gte': 'broadening',
	'$lt': 'broadening',
	'$lte': 'broadening',
	'$in': 'broadening',

	// ***A broadening inside a negation comes back out as a narrowing.*** CouchDB's `$gt: 1`
	// admits a string, so `$not` of it excludes a document jsongin keeps. This is exactly why
	// a whole-or-nothing position demands `exact` rather than merely renderable.
	'$not': 'dropped',

	// `$size` disagrees about an array holding arrays and objects.
	'$size': 'dropped',

	// ***`$regex` refuses `$options` outright***, and a `$regex` which silently lost its `i`
	// flag matches fewer strings - a narrowing wearing a simplification's clothes. The wave's
	// first measurement put six patterns to both servers and agreed on all six; it never
	// tried a flag.
	'$regex': 'dropped',

	// ***A note about the seven dropped at the top of this table.*** Running the whole
	// inventory with each operator declared alone reported `$expr`, the four `$bits*`,
	// `$comment` and `$sampleRate` as safe - because the inventory never sends one. The
	// direct probe is what settles them: both servers answer `invalid_operator`.
	// ***A declared capability which renders nothing passes vacuously***, so neither
	// measurement is trusted alone and this table is the intersection of the two.

	// Everything absent from this table keeps the ceiling's `exact`, and after the above that
	// is `$and`, `$or`, `$exists` and `$mod` - the four which agreed with jsongin in both the
	// direct probe and the whole shared inventory.

};


module.exports = {

	AdapterName: 'jsonstor-couchdb',
	AdapterDescription: 'Documents are stored on a CouchDB server.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		/*
			Settings = {
				Server: '',                          // The name or address of the server.
				Port: 5984,                          // The service port.
				Encrypt: false,                      // Whether to reach the server over https.
				DatabaseName: '',                    // The database holding this collection.
				UserName: '',                        // The user to connect as. Empty for none.
				Password: '',                        // That user's password. Empty for none.
				IdField: '_id',                      // The field which is the identifier.
				PayloadField: 'jsonstor_document',   // The field holding the document.
			}
		*/
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Server ) !== 's' ) { throw new Error( `This adapter requires a Settings.Server string parameter.` ); }
		if ( jsongin.ShortType( Settings.DatabaseName ) !== 's' ) { throw new Error( `This adapter requires a Settings.DatabaseName string parameter.` ); }
		if ( !Settings.DatabaseName.length ) { throw new Error( `Settings.DatabaseName cannot be empty.` ); }


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );
		if ( jsongin.ShortType( Storage.Settings.Port ) !== 'n' ) { Storage.Settings.Port = 5984; }
		// ***`Encrypt` rather than `Secure`, to say it the way the family says it.*** Renamed
		// 2026-09-03, when `jsonstor-mssql`'s pair was made the standing spelling across every
		// adapter whose driver can carry it. ***The rename was free because this package has
		// never been published***, which is the same licence the two `MangoExpression` options
		// were renamed under.
		//
		// ***There is no `TrustServerCertificate` here, and that is a measurement rather than an
		// omission.*** This adapter's driver is the runtime's own `fetch`, which offers no
		// supported way to relax certificate verification for one request: there is no `undici`
		// dependency to reach for, no `node:undici` builtin, and no `setGlobalDispatcher` on the
		// global. The only lever is `NODE_TLS_REJECT_UNAUTHORIZED`, which is process-wide and is
		// not a library's to set. ***So an https CouchDB presenting a self-signed certificate is
		// out of reach from here***, and declaring a setting which could not be honored would be
		// a capability that renders nothing.
		if ( jsongin.ShortType( Storage.Settings.Encrypt ) !== 'b' ) { Storage.Settings.Encrypt = false; }
		if ( jsongin.ShortType( Storage.Settings.UserName ) !== 's' ) { Storage.Settings.UserName = ''; }
		if ( jsongin.ShortType( Storage.Settings.Password ) !== 's' ) { Storage.Settings.Password = ''; }
		// ***An identifier field is always configured.*** A database this adapter did not
		// create keys on whatever field its author chose, and naming it is the only way to
		// read one. `_id` is what jsonstor writes when nobody says otherwise.
		if ( jsongin.ShortType( Storage.Settings.IdField ) !== 's' ) { Storage.Settings.IdField = '_id'; }
		if ( !Storage.Settings.IdField.length ) { Storage.Settings.IdField = '_id'; }
		// ***A payload by default***, because a database this adapter creates has no shape to
		// respect and full fidelity is what the rest of the family answers with. An empty
		// string is the other configuration - see the note at the top of this file.
		if ( jsongin.ShortType( Storage.Settings.PayloadField ) !== 's' ) { Storage.Settings.PayloadField = 'jsonstor_document'; }


		//=====================================================================
		// Which configuration this storage is in.
		function has_payload()
		{
			return ( Storage.Settings.PayloadField.length > 0 );
		}


		//=====================================================================
		// The transport.
		//=====================================================================


		//---------------------------------------------------------------------
		function base_url()
		{
			let scheme = Storage.Settings.Encrypt ? 'https' : 'http';
			return `${scheme}://${Storage.Settings.Server}:${Storage.Settings.Port}`;
		}


		//---------------------------------------------------------------------
		// ***The one thing a URL string allows that `fetch` refuses.***
		//
		// `http://admin:root@host:5984/` throws *Request cannot be constructed from a URL that
		// includes credentials*, so the credential travels as a header instead. This is the
		// first thing an author copying a working `curl` line will hit.
		function authorization_header()
		{
			if ( !Storage.Settings.UserName.length ) { return ''; }
			let credential = `${Storage.Settings.UserName}:${Storage.Settings.Password}`;
			return `Basic ${Buffer.from( credential ).toString( 'base64' )}`;
		}


		//---------------------------------------------------------------------
		// The database this storage reads and writes, escaped for a URL path.
		function database_path()
		{
			return encodeURIComponent( Storage.Settings.DatabaseName );
		}


		//---------------------------------------------------------------------
		// ***One request, and the status is returned rather than thrown on.***
		//
		// Several statuses are answers rather than failures here - a 404 from `_find` is an
		// empty collection, a 412 from a database create is a database which already exists -
		// so the caller decides what a status means. A server which cannot be reached at all
		// still throws, out of `fetch`, which is what `004) Unreachable Storage Tests`
		// requires of every read.
		async function request( Method, Path, Body )
		{
			let options = {
				method: Method,
				headers: { 'Accept': 'application/json' },
				signal: AbortSignal.timeout( REQUEST_TIMEOUT_MS ),
			};
			let authorization = authorization_header();
			if ( authorization.length ) { options.headers.Authorization = authorization; }
			if ( typeof Body !== 'undefined' )
			{
				options.headers[ 'Content-Type' ] = 'application/json';
				options.body = JSON.stringify( Body );
			}
			let response = await fetch( `${base_url()}/${Path}`, options );
			let text = await response.text();
			let parsed = null;
			if ( text.length )
			{
				try { parsed = JSON.parse( text ); }
				catch ( error ) { parsed = null; }
			}
			return { Status: response.status, Body: parsed, Text: text };
		}


		//---------------------------------------------------------------------
		// ***CouchDB says why, and the message keeps it.*** Every failure here carries an
		// `error` and a `reason`, and a message which reported only the status would throw
		// away the half which says what to do about it.
		function request_error( What, Response )
		{
			let reason = '';
			if ( Response.Body && Response.Body.error ) { reason = `${Response.Body.error}: ${Response.Body.reason}`; }
			else { reason = Response.Text.slice( 0, 200 ); }
			return new Error( `The CouchDB server answered [${Response.Status}] to a ${What} request: ${reason}` );
		}


		//---------------------------------------------------------------------
		// ***The database is created on the first write and never on a read.***
		//
		// A read against a database which does not exist is an empty collection, which is what
		// every other adapter answers for a storage nobody has written to yet. Creating one to
		// answer a `Count()` would make a question change the thing it asks about.
		//
		// ***Only a success is remembered.*** A failure cached here would answer for the life
		// of the process, and the failure it would cache is an unreachable server - which is
		// the `update_catalog` defect exactly: not a failure, a plausible answer.
		let database_ready = false;
		async function ensure_database()
		{
			if ( database_ready ) { return; }
			let response = await request( 'PUT', database_path() );
			// 201 created, 202 accepted, 412 already there.
			if ( ( response.Status === 201 ) || ( response.Status === 202 ) || ( response.Status === 412 ) )
			{
				database_ready = true;
				return;
			}
			throw request_error( 'database create', response );
		}


		//=====================================================================
		// The document layout.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***The value which goes in the key.***
		//
		// `jsonstor-sqlite`'s `id_to_key()` in CouchDB's vocabulary: the key holds `String()`
		// of the identifier so that the by-id paths compare like with like, and the payload is
		// where the value keeps its own type.
		//
		// ***Without a payload there is nowhere for the true value to live***, so an
		// identifier CouchDB cannot hold is refused by name rather than quietly stored as
		// something else. That is what the SQL adapters do with a value which does not fit its
		// column, and the message points at the same remedy.
		function id_to_key( Document )
		{
			let value = Document[ Storage.Settings.IdField ];
			if ( ( value === null ) || ( typeof value === 'undefined' ) ) { return null; }
			if ( !has_payload() && ( typeof value !== 'string' ) )
			{
				throw new Error( `Cannot store the field [${Storage.Settings.IdField}], CouchDB requires a document identifier to be a string. Configure a PayloadField to store an identifier of any type.` );
			}
			return '' + value;
		}


		//---------------------------------------------------------------------
		// The document as CouchDB is given it.
		function document_to_couch( Document, Revision, Sequence )
		{
			let raw = {};
			if ( has_payload() )
			{
				raw[ Storage.Settings.PayloadField ] = jsongin.Clone( Document );
			}
			else
			{
				// ***The document is the CouchDB document.*** Its identifier becomes the key
				// and does not also travel in the body, which is what an existing database
				// keyed on one of its own fields looks like.
				let body = jsongin.Clone( Document );
				delete body[ Storage.Settings.IdField ];
				raw = body;
			}
			raw._id = id_to_key( Document );
			if ( typeof Revision === 'string' ) { raw._rev = Revision; }
			// ***Written once, on insert.*** An update carries the sequence it already had, so
			// a document keeps the place in the natural order it was inserted at.
			if ( has_payload() && ( typeof Sequence === 'string' ) ) { raw[ SEQUENCE_FIELD ] = Sequence; }
			return raw;
		}


		//---------------------------------------------------------------------
		// ***The document as the caller gets it back.***
		//
		// `_rev` is CouchDB's and never the caller's, and neither is the sequence. A caller
		// comparing a document it wrote against the document it reads back must not find a
		// field it never wrote.
		function couch_to_document( Raw )
		{
			if ( has_payload() ) { return jsongin.Clone( Raw[ Storage.Settings.PayloadField ] ); }
			let document = {};
			// The key is the identifier, under the name this storage was told to call it.
			document[ Storage.Settings.IdField ] = Raw._id;
			for ( let key in Raw )
			{
				if ( key === '_id' ) { continue; }
				if ( key === '_rev' ) { continue; }
				if ( key === SEQUENCE_FIELD ) { continue; }
				document[ key ] = Raw[ key ];
			}
			return document;
		}


		//=====================================================================
		// The translation.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***What this adapter translates with, in one place.***
		//
		// A copy every time, so a caller which reads them through `MangoTranslation.Options()`
		// cannot reach in and change what the next query renders with.
		function translator_options()
		{
			return {
				OperatorFidelities: jsongin.Clone( OPERATOR_FIDELITIES ),
				// ***Measured, and it is the half the reasoned fidelity table missed.***
				// CouchDB answers a condition only over the documents which hold the field -
				// a negation whatever its operand, and an equality, a comparison or an `$in`
				// whose operand mentions `null`. See `MangoExpression`, which renders the repair.
				ExcludesMissingFields: true,
				// ***The same shape, and the commoner one.*** CouchDB matches an equality
				// against the field's value and never against an array's elements, where
				// jsongin and MongoDB do both. Measured on both servers 2026-09-03.
				ExcludesArrayElements: true,
			};
		}


		//---------------------------------------------------------------------
		// ***A field path in a criteria is not a field path in the stored document.***
		//
		// The document travels in a payload, so a selector which asks about `item` has to ask
		// about `jsonstor_document.item`. Measured on both servers on 2026-09-02: an equality,
		// a nested path, a range, `$in`, `$exists`, `$elemMatch`, `$regex`, `$and`, `$or` and
		// the absence repair all filter into a payload exactly as they filter the top level.
		//
		// ***Only the keys at a selector position are rewritten.*** An operator's operand is
		// handed to the server as it stands - the conditions on a field, an `$elemMatch`
		// relative to an array element - and prefixing inside one would ask about a field
		// which does not exist.
		function map_selector( Selector )
		{
			if ( jsongin.ShortType( Selector ) !== 'o' ) { return Selector; }
			let mapped = {};
			for ( let key in Selector )
			{
				let value = Selector[ key ];
				// The logical operators hold selectors of their own, so their children are
				// selector positions too.
				if ( ( key === '$and' ) || ( key === '$or' ) || ( key === '$nor' ) )
				{
					if ( jsongin.ShortType( value ) !== 'a' ) { mapped[ key ] = value; continue; }
					let children = [];
					for ( let index = 0; index < value.length; index++ )
					{
						children.push( map_selector( value[ index ] ) );
					}
					mapped[ key ] = children;
					continue;
				}
				if ( key.startsWith( '$' ) ) { mapped[ key ] = value; continue; }
				mapped[ map_field_path( key ) ] = value;
			}
			return mapped;
		}


		//---------------------------------------------------------------------
		// One field path, as the stored document spells it.
		function map_field_path( Path )
		{
			if ( has_payload() ) { return `${Storage.Settings.PayloadField}.${Path}`; }
			// ***Without a payload the identifier is the key***, which CouchDB always calls
			// `_id` whatever this storage calls the field.
			if ( Path === Storage.Settings.IdField ) { return '_id'; }
			return Path;
		}


		//---------------------------------------------------------------------
		function translate( Criteria )
		{
			return jsonstor.MangoExpression.Translate( {
				Criteria: Criteria,
				Options: translator_options(),
			} );
		}


		//---------------------------------------------------------------------
		// What the two stages did, for the caller which asked to be told.
		function report_scan( Options, Translation, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: 'MangoExpression',
				Pushdown: Translation.Pushdown,
				PushdownRows: Scanned,
				Residual: Translation.Residual,
				ResidualRows: Matched,
			} );
			return;
		}


		//=====================================================================
		// Reading.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***Every document the pushdown admits, paged to the end.***
		//
		// The loop ends on a short page rather than on a bookmark, because a bookmark is
		// always returned and following one past the end costs a round trip per call for the
		// life of the process.
		async function run_find( Selector )
		{
			let documents = [];
			let bookmark = '';
			while ( true )
			{
				let body = { selector: Selector, limit: FIND_PAGE_SIZE };
				if ( bookmark.length ) { body.bookmark = bookmark; }
				let response = await request( 'POST', `${database_path()}/_find`, body );
				// A database nobody has written to is an empty collection.
				if ( response.Status === 404 ) { return documents; }
				if ( response.Status !== 200 ) { throw request_error( 'find', response ); }
				let page = ( response.Body && Array.isArray( response.Body.docs ) ) ? response.Body.docs : [];
				for ( let index = 0; index < page.length; index++ )
				{
					documents.push( page[ index ] );
				}
				if ( page.length < FIND_PAGE_SIZE ) { break; }
				bookmark = ( response.Body && response.Body.bookmark ) ? String( response.Body.bookmark ) : '';
				if ( !bookmark.length ) { break; }
			}
			return documents;
		}


		//---------------------------------------------------------------------
		// ***The documents this criteria admits, in natural order, each with its key.***
		//
		// The pushdown narrows what travels and jsongin decides what matches, which is the two
		// stage bargain every adapter in this family makes. ***When the residual is null the
		// second stage is skipped***, because the translator has taken responsibility for the
		// whole criteria.
		async function find_entries( Criteria )
		{
			let translation = translate( Criteria );

			// ***A malformed criteria is refused before anything is read.*** Waiting for the
			// loop below would make the refusal depend on the collection holding something, so
			// `FindMany( { $nope: 1 } )` would throw against a full collection and answer []
			// against an empty one. Putting it one empty document is the cheapest way to ask.
			if ( translation.Residual !== null ) { jsongin.Query( {}, translation.Residual ); }

			let rows = await run_find( map_selector( translation.Pushdown ) );
			let entries = [];
			for ( let index = 0; index < rows.length; index++ )
			{
				let raw = rows[ index ];
				let document = couch_to_document( raw );
				if ( translation.Residual !== null )
				{
					if ( !jsongin.Query( document, translation.Residual ) ) { continue; }
				}
				entries.push( {
					Key: raw._id,
					Revision: raw._rev,
					Sequence: raw[ SEQUENCE_FIELD ],
					Document: document,
				} );
			}

			// ***The natural order is written down rather than inferred.*** A `_find` answers
			// in the order of whichever index it chose, so the sequence field decides - and a
			// database with no sequence field is read in the server's `_id` order, which is
			// what `jsonstor-mssql` answers for a table it did not create.
			entries.sort(
				function ( Left, Right )
				{
					let left = has_payload() ? ( Left.Sequence || '' ) : Left.Key;
					let right = has_payload() ? ( Right.Sequence || '' ) : Right.Key;
					if ( left < right ) { return -1; }
					if ( left > right ) { return 1; }
					return 0;
				} );

			return { Entries: entries, Scanned: rows.length, Translation: translation };
		}


		//---------------------------------------------------------------------
		// ***The first document satisfying Criteria.***
		//
		// This reads the collection rather than stopping early, and the cost is honest rather
		// than hidden: "first" means first in the natural order, and nothing can be ordered
		// until all of it has arrived.
		async function find_first( Criteria )
		{
			let search = await find_entries( Criteria );
			if ( search.Entries.length ) { return { Search: search, Found: search.Entries[ 0 ] }; }
			return { Search: search, Found: null };
		}


		//---------------------------------------------------------------------
		// null, undefined and {} all mean "every document".
		function criteria_matches_everything( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( 'lu'.includes( short_type ) ) { return true; }
			if ( Object.keys( Criteria ).length === 0 ) { return true; }
			return false;
		}


		//---------------------------------------------------------------------
		// Criteria this storage will accept at all.
		function check_criteria( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( short_type ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }
			return;
		}


		//=====================================================================
		// Writing.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***A counter which makes a sequence unique inside one process.***
		//
		// Two documents written in the same nanosecond would otherwise share a place in the
		// natural order. `jsonstor-redis` and `jsonstor-leveldb` close the same exposure the
		// same way, and every component is padded to a fixed width because a variable width
		// field sorts lexicographically in a different order than it was written in.
		let key_sequence = 0;
		function new_sequence()
		{
			let hr_time = process.hrtime();
			let milliseconds = String( ( new Date() ).getTime() ).padStart( 14, '0' );
			let hr_seconds = String( hr_time[ 0 ] ).padStart( 10, '0' );
			let hr_nanoseconds = String( hr_time[ 1 ] ).padStart( 9, '0' );
			key_sequence = ( key_sequence + 1 ) % 1000000;
			let sequence = String( key_sequence ).padStart( 6, '0' );
			return `${milliseconds}.${hr_seconds}.${hr_nanoseconds}.${sequence}`;
		}


		//---------------------------------------------------------------------
		// ***The identifier is written on insert and never again.***
		//
		// Every adapter in this family mints one at exactly two sites, `InsertOne` and
		// `InsertMany`, and no adapter assigns one during an update or a replace.
		function with_identifier( Document )
		{
			let document = jsongin.Clone( Document );
			if ( typeof document[ Storage.Settings.IdField ] === 'undefined' )
			{
				document[ Storage.Settings.IdField ] = jsonstor.NewUniqueID();
			}
			return document;
		}


		//---------------------------------------------------------------------
		// ***One `_bulk_docs` per operation, rather than one round trip per document.***
		//
		// The same shape as the connection per statement which cost this family a measured
		// 34ms against 3.8ms in `jsonstor-mssql`. There is no reason to buy that twice.
		//
		// ***`_bulk_docs` answers 201 whether or not every document was written***, and puts
		// each document's own outcome in the array. A caller which read only the status would
		// report a write which did not happen, so every entry is checked.
		async function write_documents( Documents )
		{
			if ( !Documents.length ) { return []; }
			await ensure_database();
			let response = await request( 'POST', `${database_path()}/_bulk_docs`, { docs: Documents } );
			if ( ( response.Status !== 201 ) && ( response.Status !== 202 ) ) { throw request_error( 'bulk write', response ); }
			let results = Array.isArray( response.Body ) ? response.Body : [];
			for ( let index = 0; index < results.length; index++ )
			{
				if ( results[ index ].error )
				{
					throw new Error( `The CouchDB server refused a document during a bulk write: ${results[ index ].error}: ${results[ index ].reason}` );
				}
			}
			return results;
		}


		//---------------------------------------------------------------------
		// ***What to write so that one existing document becomes another.***
		//
		// ***The key is the identifier, so a write which changes it is a move.*** In place
		// when the identifier is unchanged, which is what an update or a replace ordinarily
		// does; otherwise the old document is removed and the new one written in the same
		// request, so the collection never holds both. The sequence is carried over either
		// way, because a document keeps its place in the natural order.
		function stage_replacement( Entry, Document )
		{
			let key = id_to_key( Document );
			if ( key === Entry.Key )
			{
				return [ document_to_couch( Document, Entry.Revision, Entry.Sequence ) ];
			}
			return [
				{ _id: Entry.Key, _rev: Entry.Revision, _deleted: true },
				document_to_couch( Document, undefined, Entry.Sequence ),
			];
		}


		//=====================================================================
		// StorageInfo
		//=====================================================================


		// ***What this storage is actually talking to.*** The welcome document at the root
		// carries the server's own version and needs no database to exist.
		Storage.StorageInfo = async function ( Options )
		{
			let response = await request( 'GET', '' );
			if ( response.Status !== 200 ) { throw request_error( 'server info', response ); }
			let version = ( response.Body && response.Body.version ) ? String( response.Body.version ) : '';
			return jsonstor.BuildStorageInfo( Storage, {
				Product: 'CouchDB',
				Version: version,
				Endpoint: base_url(),
			} );
		};


		//---------------------------------------------------------------------
		// ***The floor is checked against the server once, on the first operation.***
		//
		// The transport is stateless and `GetStorage` is synchronous, so a server below the
		// floor cannot be caught at construction and surfaces on the first operation instead.
		// ***The outcome is remembered***, so a storage pointed at a server its profile does
		// not cover fails the same way every time rather than only once.
		//
		// ***A server which did not answer is not remembered***, because that is a transient
		// failure rather than an answer, and caching it would poison the storage.
		let floor_check = null;
		async function ensure_floor_checked()
		{
			if ( floor_check !== null )
			{
				if ( floor_check.Error ) { throw floor_check.Error; }
				return;
			}
			// Set before asking, so that StorageInfo's own request does not re-enter this.
			floor_check = {};
			try { await Storage.StorageInfo(); }
			catch ( error )
			{
				if ( error && error.DialectBoundary ) { floor_check.Error = error; }
				else { floor_check = null; }
				throw error;
			}
			return;
		}


		//=====================================================================
		// DropStorage
		//=====================================================================


		// ***The database is the collection, so dropping it is one request.***
		Storage.DropStorage = async function ( Options )
		{
			await ensure_floor_checked();
			let response = await request( 'DELETE', database_path() );
			// The next write creates it again.
			database_ready = false;
			if ( ( response.Status === 200 ) || ( response.Status === 202 ) || ( response.Status === 404 ) ) { return true; }
			throw request_error( 'database drop', response );
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		// CouchDB decides its own persistence, and no setting of this adapter's changes that.
		// `_ensure_full_commit` existed to force it and was removed in 3.0, so asking for it
		// would work against one of the two servers this profile covers and fail against the
		// other.
		Storage.FlushStorage = async function ( Options )
		{
			await ensure_floor_checked();
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();

			// ***An unfiltered count never reads a document.*** The database document carries
			// `doc_count`, which is this medium's version of the cheap answer every other
			// adapter's count of everything gets from its own.
			if ( criteria_matches_everything( Criteria ) )
			{
				let response = await request( 'GET', database_path() );
				if ( response.Status === 404 )
				{
					report_scan( Options, translate( Criteria ), 0, 0 );
					return 0;
				}
				if ( response.Status !== 200 ) { throw request_error( 'database info', response ); }
				let counted = Number( response.Body.doc_count ) || 0;
				report_scan( Options, translate( Criteria ), counted, counted );
				return counted;
			}

			let search = await find_entries( Criteria );
			report_scan( Options, search.Translation, search.Scanned, search.Entries.length );
			return search.Entries.length;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			await ensure_floor_checked();
			let document = with_identifier( Document );
			await write_documents( [ document_to_couch( document, undefined, new_sequence() ) ] );
			if ( Options.ReturnDocuments ) { return document; }
			return 1;
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Documents ) !== 'a' ) { throw new Error( `Documents must be an array of objects.` ); }
			await ensure_floor_checked();
			let inserted = [];
			let raw_documents = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				let document = with_identifier( Documents[ index ] );
				inserted.push( document );
				raw_documents.push( document_to_couch( document, undefined, new_sequence() ) );
			}
			await write_documents( raw_documents );
			if ( Options.ReturnDocuments ) { return inserted; }
			return inserted.length;
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let document = null;
			if ( search.Found ) { document = jsongin.Project( search.Found.Document, Projection ); }
			report_scan( Options, search.Search.Translation, search.Search.Scanned, document ? 1 : 0 );
			return document;
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_entries( Criteria );
			let documents = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				documents.push( jsongin.Project( search.Entries[ index ].Document, Projection ) );
			}
			report_scan( Options, search.Translation, search.Scanned, documents.length );
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		// ***The sort and the limit are applied here rather than by the server.***
		//
		// A Mango sort needs an index which covers exactly the fields being sorted on, and
		// building one per call would make a read a schema change. `MangoExpression` says as
		// much - it reports `SortAbsorbed: false` - so this is the translator's declaration
		// carried out rather than a shortcut around it.
		Storage.FindMany2 = async function ( Criteria, Projection, Sort, MaxCount, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_entries( Criteria );
			let documents = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				documents.push( jsongin.Project( search.Entries[ index ].Document, Projection ) );
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length >= MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			report_scan( Options, search.Translation, search.Scanned, documents.length );
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( search.Found )
			{
				modified = jsongin.Update( search.Found.Document, Updates );
				await write_documents( stage_replacement( search.Found, modified ) );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_entries( Criteria );
			let modified = [];
			let raw_documents = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				let entry = search.Entries[ index ];
				let document = jsongin.Update( entry.Document, Updates );
				modified.push( document );
				raw_documents = raw_documents.concat( stage_replacement( entry, document ) );
			}
			await write_documents( raw_documents );
			if ( Options.ReturnDocuments ) { return modified; }
			return modified.length;
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ( Criteria, Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			if ( jsongin.ShortType( Document[ Storage.Settings.IdField ] ) === 'u' ) { throw new Error( `Document must contain an ${Storage.Settings.IdField} field.` ); }
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( search.Found )
			{
				modified = jsongin.Clone( Document );
				await write_documents( stage_replacement( search.Found, modified ) );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let deleted = null;
			let deleted_count = 0;
			if ( search.Found )
			{
				deleted = search.Found.Document;
				await write_documents( [ { _id: search.Found.Key, _rev: search.Found.Revision, _deleted: true } ] );
				deleted_count++;
			}
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted_count;
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_entries( Criteria );
			let deleted = [];
			let raw_documents = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				let entry = search.Entries[ index ];
				deleted.push( entry.Document );
				raw_documents.push( { _id: entry.Key, _rev: entry.Revision, _deleted: true } );
			}
			await write_documents( raw_documents );
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted.length;
		};


		//=====================================================================
		// MangoTranslation
		//
		// ***What a Mango-translating adapter advertises beyond the Storage interface.***
		// Its presence is the capability declaration, the same way `Storage.SqlTranslation` is
		// in the SQL adapters: a suite asks the constructed Storage rather than consulting a
		// list somewhere which could disagree with it. Constructing a Storage opens no
		// connection, so the question is answerable while the server is down.
		//
		// ***`jsonstor-mongodb` declares no options and this one declares many***, which is
		// the whole reason `MangoExpression` is parameterized rather than being MongoDB's
		// alone. The two adapters share one translator and narrow it differently.
		//=====================================================================

		Storage.MangoTranslation = {
			TranslatorName: 'MangoExpression',

			// The options this adapter translates with. A copy, so a caller cannot alter them.
			Options: function () { return translator_options(); },

			// ***Whether a criteria is decided by the server alone.***
			Absorbs: function ( Criteria )
			{
				return ( translate( Criteria ).Residual === null );
			},

			// The selector the server is really given, payload prefix and all. Pure: it opens
			// no connection and reads no document.
			Pushdown: function ( Criteria )
			{
				return map_selector( translate( Criteria ).Pushdown );
			},
		};

		//=====================================================================
		return Storage;
	},

};


//---------------------------------------------------------------------
// ***This package is one prime and four aliases.***
//
// The plan for this wave asked whether 2.x and 3.x are two profiles, and ***the measurement
// answered no on 2026-09-02***: CouchDB 2.3.1 and 3.5.2 were put the same 45 probes - every
// jsongin query operator, the four narrowing repairs, and six `$regex` constructs - and
// answered identically. The same results, the same refusals, the same error wording.
//
// ***A prime is a named profile describing a real change in behavior***, so a second prime
// here would assert a difference which does not exist. This is the same reasoning which gave
// `jsonstor-redis` one prime for two products.
//
// ***3.0 dropped the admin party and 2.3 did not***, which is the one difference anybody will
// notice - and it is a setup difference rather than a behavioral one. Both servers here are
// given a credential and the adapter sees one shape. That fact belongs to the containers and
// is recorded in jsonx/.plans/testing-environment.md.
//
// See jsonx/.plans/wave-3-http-transport.md and jsonx/.plans/versioned-adapters.md.

const COUCHDB_V23 = {
	AdapterName: 'jsonstor-couchdb-v2.3',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: module.exports.GetAdapter,
	// ***The floor this profile starts at, and it was found by standing the older server
	// up.*** 2.3.1 is the oldest CouchDB this adapter has actually been run against, and the
	// standing rule is that a floor is measured rather than read off whichever container
	// happens to be running - it has been paid for three times in this family already.
	Version: [ 2, 3 ],
	// ***The newest server it has been run against.*** Every part of it, because the
	// comparison zero-pads and a short ceiling makes a prime warn about its own test server.
	MeasuredTo: [ 3, 5, 2 ],
};

module.exports.Adapters = [ COUCHDB_V23 ];

// ***The bare name is listed here rather than left on the plugin object.*** Naming
// `jsonstor-couchdb` stops the plugin registering itself under it, so `GetStorage` reports the
// prime it resolved to instead of reporting itself as its own profile.
module.exports.Aliases = {
	'jsonstor-couchdb': 'jsonstor-couchdb-v2.3',
	'jsonstor-couchdb-v2': 'jsonstor-couchdb-v2.3',
	'jsonstor-couchdb-v3': 'jsonstor-couchdb-v2.3',
	'jsonstor-couchdb-v3.5': 'jsonstor-couchdb-v2.3',
};
