# Vendored Dependencies

`xlsx-0.20.3.tgz` is the official SheetJS Community Edition release archive:

- Source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
- Documentation: https://docs.sheetjs.com/docs/getting-started/installation/frameworks/
- SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`

The archive is vendored because the public npm registry only serves the
vulnerable `xlsx@0.18.5` release. Keep the exact version pinned in
`package.json` and update this file with the SHA-256 checksum whenever the
archive is replaced.
