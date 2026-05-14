/**
 * Shared types for the in-process Blossom server.
 *
 * Kept in a separate file so route handlers can import these without
 * pulling in the heavier sqlite + http server modules.
 */

// One row per blob the server is storing. `uploader_kind` carries the
// load-bearing distinction for promote (Phase E): blobs uploaded by a
// test identity refuse to migrate to public Blossom. Owner / whitelist
// blobs are eligible.
export type UploaderKind = 'owner' | 'whitelist' | 'test-identity';

export interface BlobRecord {
  sha256:          string;
  size:            number;
  mime:            string;
  uploaderPubkey:  string;       // hex
  uploaderKind:    UploaderKind;
  createdAt:       number;       // epoch ms
}

// Stats snapshot for the dashboard status card + /api/blossom-config.
export interface BlossomStats {
  blobCount:        number;
  totalBytes:       number;
  uploadsByKind: {
    owner:         number;
    whitelist:     number;
    'test-identity': number;
  };
  quotaBytes:       number;     // configured upper bound
  dataDir:          string;
}
