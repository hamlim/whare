### Unreleased:

### [0.2.3] - February 20th, 2025

- Fix whare.version duplicate when running update

### [0.2.2] - February 14th, 2025

- Fix whare.version change to root package.json if it contains diffs
- Fix ignore bun.lock diffs

### [0.2.1] - February 13th, 2025

- Add support for `ignoredWorkspaces` config to ignore packages or apps during the update process

### [0.2.0] - February 13th, 2025

- Add smarter diffing for `package.json` files
- Don't clobber changes from template workspaces against workspaces that also exist in the monorepo template
  - Fixes a bug where `components` or `utils` workspaces would be overwritten with changes from the `template-library` workspace

### [0.1.4] - January 23rd, 2025

- Simplify flow for updates, don't create new branches or stage changes automatically

### [0.1.3] - January 23rd, 2025

- Fix cache of stale versions of template-monorepo repo in degit cache
- remove usage of `degit`

### [0.1.2] - January 23rd, 2025

- Fix publishing

### [0.1.1] - January 22nd, 2025

- Inital support for `update`

### [0.1.0] - January 20th, 2025

- Inital package
