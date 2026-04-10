# Release checklist

Run this before every `npm publish`. Steps must be done in order.

## 1. Version bump

Update version in all four places:
- [ ] `package.json`
- [ ] `src/onboard/components/Banner.tsx`
- [ ] `src/cli.tsx` (version case)
- [ ] `README.md` (version badge / header line)

## 2. CHANGELOG

- [ ] Move `[x.y.z] — in progress` to `[x.y.z] — YYYY-MM-DD` with today's date
- [ ] Review all entries are accurate

## 3. Build and verify

```bash
npm run build
node dist/cli.js version          # confirm version string
node dist/cli.js help             # spot-check
node dist/cli.js onboard --demo   # smoke test wizard
```

## 4. Generate SHA256 checksum

```bash
# Pack the tarball (does not publish)
npm pack

# Generate checksum
sha256sum nostr-station-x.y.z.tgz > nostr-station-x.y.z.tgz.sha256
cat nostr-station-x.y.z.tgz.sha256   # verify it looks sane
```

## 5. Commit and tag

```bash
git add .
git commit -m "chore: bump version to x.y.z"
git tag vx.y.z
git push origin main
git push origin vx.y.z
```

## 6. Publish to npm

```bash
npm publish
```

## 7. Create GitHub release

- Go to: github.com/jared-logan/nostr-station/releases/new
- Tag: `vx.y.z`
- Title: `nostr-station vx.y.z`
- Body: paste the `[x.y.z]` section from CHANGELOG.md
- Upload release assets:
  - [ ] `nostr-station-x.y.z.tgz`
  - [ ] `nostr-station-x.y.z.tgz.sha256`
- Publish release

## 8. Verify install

```bash
# In a clean shell
npm install -g nostr-station@latest
nostr-station version
```

---

**Note on checksum verification:** The SHA256 published in step 4 allows security-conscious users to verify the tarball before installing:

```bash
# Manual verified install
npm pack nostr-station@x.y.z   # downloads tarball
curl -fsSL https://github.com/jared-logan/nostr-station/releases/download/vx.y.z/nostr-station-x.y.z.tgz.sha256 | sha256sum -c
npm install -g nostr-station-x.y.z.tgz   # install from local verified file
```

This verifies the tarball was not tampered with after publication. It does not protect against a compromised npm registry serving a different package at install time.
