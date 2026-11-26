/**
 * Public entry point for the local-draft persistence module.
 *
 * The module is store-agnostic: it persists a validated record plus one
 * optional reference-image blob in a single atomic step and returns explicit
 * result envelopes for every expected failure. The Lead owns the Zustand/store
 * bridge; nothing here imports React, Three.js or application state.
 */

export { LOCAL_FORMAT_VERSION, DRAFT_SLOT, LocalPersistenceError } from './types';

export type {
  ContentTriple,
  StoredEditorStateV1,
  StoredCameraV1,
  StoredReferenceMetaV1,
  StoredContentV1,
  StoredIdentityV1,
  StoredDraftV1,
  LocalStorageCode,
  StoredBlobV1,
  SaveDraftInput,
  SaveDraftResult,
  LoadDraftResult,
  DraftRepository,
} from './types';

export {
  sha256Hex,
  stableContentJson,
  contentDigest,
  verifyContentDigest,
  validateStoredDraft,
  buildStoredDraft,
} from './record';

export type {
  StoredDraftValidation,
  ContentDigestVerification,
  BuildStoredDraftInput,
  BuildStoredDraftReferenceInput,
  BuiltStoredDraft,
  DraftBlobPayload,
} from './record';

export { createMemoryRepository } from './memory';
export type { MemoryRepository, MemoryFault } from './memory';

export { createIndexedDbRepository } from './idb';
export type { IndexedDbRepositoryOptions } from './idb';
