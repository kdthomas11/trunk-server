#!/usr/bin/env node
/**
 * Fails if the three copies of the User schema have drifted apart.
 *
 *   node scripts/check-user-schema-drift.js
 *
 * account, admin and backend each define their own User model over the same
 * collection. That is not going to change soon - they are separate Docker build
 * contexts, so a shared module would mean restructuring all three images - but
 * the failure mode it creates is silent, which is the part worth fixing.
 *
 * Mongoose drops any field that is not in the schema. Add a field in account,
 * forget it in backend, and backend does not error: it just reads that field as
 * undefined, forever. `plan` is the expensive case - every Supporter silently
 * reads as free and the gated features quietly stop working. Both
 * backend/models/user.js and backend/middleware/auth.js carry comments warning
 * about exactly this, which is a good sign the design needs a guard rather than
 * another comment.
 *
 * Two things are checked:
 *
 *   1. All three declare the same set of top-level fields.
 *   2. No schema declares the same field twice. A duplicate key in an object
 *      literal is legal JavaScript and invisible on reading - the last one
 *      silently wins. `email` was declared twice for a while, which is how it
 *      lost `unique: true` and `lowercase: true` without anything erroring.
 *
 * No dependencies, so this runs anywhere node does - including CI, where none
 * of the services' node_modules are installed.
 *
 * Exits 0 when the schemas agree, 1 when they do not.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const MODELS = [
	{ service: "account", file: "account/server/models/user.js" },
	{ service: "admin", file: "admin/server/models/user.js" },
	{ service: "backend", file: "backend/models/user.js" }
];

/**
 * Top-level keys of the object literal passed to mongoose.Schema(...).
 *
 * Walks the literal counting brace depth rather than matching a regex against
 * the whole file, so nested definitions (local.email, and anything with its own
 * options object) are not mistaken for top-level fields. Duplicates are kept
 * rather than collapsed - finding them is half the point.
 */
function schemaFields(source) {
	const start = source.search(/mongoose\.Schema\s*\(\s*\{/);
	if (start === -1) return null;

	const open = source.indexOf("{", start);
	let depth = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let quote = null;
	const fields = [];

	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];

		if (inLineComment) {
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") { inBlockComment = false; i++; }
			continue;
		}
		if (quote) {
			if (ch === "\\") { i++; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
		if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }

		if (ch === "{" || ch === "[") { depth++; continue; }
		if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) break;
			continue;
		}

		// A field name is an identifier at depth 1 followed by a colon.
		if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
			const rest = source.slice(i);
			const match = rest.match(/^([A-Za-z_$][\w$]*)\s*:/);
			if (match) {
				fields.push(match[1]);
				i += match[1].length - 1;
			}
		}
	}
	return fields;
}

function report(lines) {
	for (const line of lines) console.log(line);
}

const parsed = [];
let failed = false;

for (const model of MODELS) {
	const full = path.join(ROOT, model.file);
	if (!fs.existsSync(full)) {
		console.error(`FAIL  ${model.file} does not exist`);
		process.exit(1);
	}
	const fields = schemaFields(fs.readFileSync(full, "utf8"));
	if (!fields) {
		console.error(`FAIL  could not find a mongoose.Schema({...}) literal in ${model.file}`);
		process.exit(1);
	}
	parsed.push({ ...model, fields });
}

// --- 1. duplicate keys within one schema ------------------------------------

for (const model of parsed) {
	const seen = new Set();
	const duplicates = new Set();
	for (const field of model.fields) {
		if (seen.has(field)) duplicates.add(field);
		seen.add(field);
	}
	if (duplicates.size > 0) {
		failed = true;
		report([
			"",
			`FAIL  ${model.file} declares a field more than once:`,
			...[...duplicates].map(f => `        ${f}`),
			"",
			"      The last declaration silently replaces the earlier one, taking its",
			"      options with it. Delete the duplicate."
		]);
	}
}

// --- 2. the three field sets must match -------------------------------------

const union = [...new Set(parsed.flatMap(m => m.fields))].sort();
const missing = [];

for (const field of union) {
	const absent = parsed.filter(m => !m.fields.includes(field)).map(m => m.service);
	if (absent.length > 0) {
		missing.push({ field, absent, present: parsed.filter(m => m.fields.includes(field)).map(m => m.service) });
	}
}

if (missing.length > 0) {
	failed = true;
	report(["", "FAIL  the three User schemas declare different fields:", ""]);
	for (const row of missing) {
		report([`      ${row.field}`, `        present in : ${row.present.join(", ")}`, `        missing in : ${row.absent.join(", ")}`]);
	}
	report([
		"",
		"      Mongoose drops fields it does not know about, so the service missing",
		"      one will read it as undefined and never error. Add it to every copy,",
		"      even where nothing reads it yet."
	]);
}

if (failed) {
	console.log("");
	process.exit(1);
}

console.log(`OK  all ${parsed.length} User schemas declare the same ${union.length} fields, with no duplicates.`);
for (const model of parsed) {
	console.log(`      ${model.service.padEnd(8)} ${model.fields.length} fields  ${model.file}`);
}
