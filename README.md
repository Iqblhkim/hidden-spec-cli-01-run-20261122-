# mend

`mend` applies an edit that an AI model wrote to a tree of text files, in four
formats: unified diff, SEARCH/REPLACE blocks, V4A patches, and JSON edits.
Every file is changed or nothing is.

Run it as `node main.ts [options] [PATCH]` (Node 22, standard library only),
with the working directory as the root of the tree. See `SPEC.md` in the kit
for the full contract. Options: `--format=NAME` (`auto`, `unified`,
`search-replace`, `v4a`, `json`), `--check` (do everything but write),
`--strict` (exact, tier-0 matching only). PATCH is read from stdin when
absent or `-`.

Exit 0 lists the changed files (`A`/`D`/`M`, `R old -> new` for moves) and
`ok: <n> files`; exit 1 lists each failed edit and `failed: <k> of <n> edits`;
exit 2 reports a usage, missing-patch, format or parse error and writes
nothing.

Practice set (kit): `node check.ts ../program/generator/practice.json`
from the starter directory — 100/100, practice score 1000.
