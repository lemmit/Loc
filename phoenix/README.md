phoenix/ — pack-agnostic HEEx shared-source slot.

The pack loader (src/generator/react/templating/loader-fs.ts) reads
every `.hbs` file in this directory when loading a HEEx-format pack
(currently only `ashPhoenix`), making them available as logical
shared sources alongside the pack's own templates.

Empty in v0: the ashPhoenix pack ships its shell files (theme,
main, app-shell, format-helpers) directly.  This slot is reserved
for future templates that should be available to every HEEx pack
without each having to re-declare them — mirroring how vite/,
api/, and docker/ supply shared sources to every TSX pack.

Drop files here as `<name>.hbs`; they become available to
templates via `{{> <name>}}` partial includes.
