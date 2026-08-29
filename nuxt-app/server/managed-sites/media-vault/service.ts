import { randomUUID } from "node:crypto";
import { createError } from "h3";
import { stableFingerprint } from "../../seo-geo-core/repository";
import {
  extensionForMime,
  hashBytes,
  inspectMediaBytes,
  MEDIA_LIMITS,
  sanitizeMediaFilename,
  validateTransformation,
  validateUploadDeclaration,
} from "./validation";
import { mediaObjectKey } from "./storage";
import type {
  MediaActor,
  MediaAssetProjection,
  MediaImageProcessor,
  MediaQuotaDelta,
  MediaRightsMetadata,
  MediaSecurityScanner,
  MediaStoragePort,
  MediaTenantScope,
  MediaTransformation,
  MediaUploadRequest,
  MediaUploadSession,
  MediaVaultRepository,
  MediaVariantProjection,
  MediaVisibility,
} from "./types";

function forbidden(message: string): never {
  throw createError({ statusCode: 403, statusMessage: message });
}
function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message });
}
function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message });
}
function assertActor(
  actor: MediaActor,
  scope: MediaTenantScope,
  mutation = false
): void {
  if (
    actor.ownerUserId !== scope.ownerUserId ||
    actor.projectId !== scope.projectId
  )
    forbidden("Media authority is outside the active tenant and site.");
  if (mutation && actor.role === "viewer")
    forbidden("Viewer role cannot mutate the media vault.");
}
function idempotency(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(value)
  )
    invalid("Media idempotency key is invalid.");
  return value;
}
function event(input: {
  type: string;
  assetId?: string;
  uploadId?: string;
  actor: MediaActor;
  metadata?: Record<string, unknown>;
  before?: string | null;
  after?: string | null;
}) {
  const occurredAt = new Date().toISOString();
  const metadata = input.metadata || {};
  const receiptFingerprint = stableFingerprint({
    version: "media-event-v1",
    type: input.type,
    scope: {
      ownerUserId: input.actor.ownerUserId,
      projectId: input.actor.projectId,
    },
    assetId: input.assetId || null,
    uploadId: input.uploadId || null,
    authority: input.actor.authority,
    metadata,
    before: input.before || null,
    after: input.after || null,
  });
  return {
    eventType: input.type,
    assetId: input.assetId || null,
    uploadId: input.uploadId || null,
    receiptFingerprint,
    metadata,
    occurredAt,
  };
}
function quotaAllows(
  quota: Awaited<ReturnType<MediaVaultRepository["getQuota"]>>,
  bytes: number,
  count = 1
): void {
  if (quota.assetCountUsed + count > quota.maxAssetCount)
    throw createError({
      statusCode: 413,
      statusMessage: "Media asset count quota would be exceeded.",
    });
  if (quota.originalBytesUsed + bytes > quota.maxOriginalBytes)
    throw createError({
      statusCode: 413,
      statusMessage: "Media original-byte quota would be exceeded.",
    });
  if (quota.monthlyUploadBytesUsed + bytes > quota.maxMonthlyUploadBytes)
    throw createError({
      statusCode: 413,
      statusMessage: "Monthly media upload quota would be exceeded.",
    });
  if (
    quota.monthlyProcessingCountUsed + count >
    quota.maxMonthlyProcessingCount
  )
    throw createError({
      statusCode: 413,
      statusMessage: "Monthly media processing quota would be exceeded.",
    });
}
const zeroQuota = (): MediaQuotaDelta => ({
  originalBytes: 0,
  assetCount: 0,
  uploadBytes: 0,
  processingCount: 0,
});
const uploadQuota = (bytes: number, assetCount: number): MediaQuotaDelta => ({
  originalBytes: bytes,
  assetCount,
  uploadBytes: bytes,
  processingCount: 1,
});

async function deleteOrQueueMediaObjects(
  dependencies: { repository: MediaVaultRepository; storage: MediaStoragePort },
  scope: MediaTenantScope,
  sourceReference: string,
  objectKeys: string[],
  finalizeDeletion?: { assetId: string; originalBytes: number }
) {
  const unique = [...new Set(objectKeys)].filter(Boolean).slice(0, 12);
  const failed: string[] = [];
  const receipts: Array<{ objectKey: string; receiptReference: string }> = [];
  for (const objectKey of unique) {
    try {
      const deletion = await dependencies.storage.deleteObject({
        ...scope,
        objectKey,
      });
      receipts.push({ objectKey, receiptReference: deletion.receiptReference });
    } catch {
      failed.push(objectKey);
    }
  }
  if (failed.length) {
    const stateFingerprint = stableFingerprint({
      version: "media-object-cleanup-state-v1",
      scope,
      sourceReference,
      objectKeys: failed,
    });
    await dependencies.repository.enqueueObjectCleanup(scope, {
      sourceReference,
      stateFingerprint,
      objectKeys: failed,
      finalizeDeletion,
    });
  }
  return { receipts, queuedObjectKeys: failed };
}

export async function requestMediaUploadIntent(
  dependencies: { repository: MediaVaultRepository; storage: MediaStoragePort },
  actor: MediaActor,
  raw: MediaUploadRequest,
  now = new Date()
) {
  const scope = { ownerUserId: actor.ownerUserId, projectId: actor.projectId };
  assertActor(actor, scope, true);
  const parsed = validateUploadDeclaration(raw);
  const key = idempotency(raw.idempotencyKey);
  const visibility = raw.visibility;
  if (!["public", "private", "internal"].includes(visibility))
    invalid("Media visibility is invalid.");
  const requestFingerprint = stableFingerprint({
    version: "media-upload-request-v1",
    ...scope,
    ...parsed,
    visibility,
  });
  return dependencies.repository.transaction(async repository => {
    const replay = await repository.findUploadByIdempotency(scope, key);
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint)
        conflict(
          "Media upload idempotency key collided with a different request."
        );
      const authorization = await dependencies.storage.createUploadIntent({
        ...scope,
        uploadId: replay.uploadId,
        objectKey: replay.objectKey,
        byteSize: replay.declaredBytes,
        contentType: replay.declaredMime,
        expiresAt: new Date(replay.expiresAt),
      });
      return { session: replay, authorization, replayed: true };
    }
    await repository.reserveQuota(scope, {
      idempotencyKey: key,
      requestFingerprint,
      delta: uploadQuota(parsed.declaredBytes, 1),
    });
    const uploadId = randomUUID();
    const assetId = randomUUID();
    const expiresAt = new Date(now.getTime() + MEDIA_LIMITS.uploadTtlMs);
    const objectKey = mediaObjectKey(scope, {
      kind: "upload",
      identity: uploadId,
      extension: extensionForMime(parsed.declaredMime),
    });
    const session: MediaUploadSession = {
      ...scope,
      uploadId,
      assetId,
      objectKey,
      filename: parsed.filename,
      declaredMime: parsed.declaredMime,
      declaredBytes: parsed.declaredBytes,
      visibility,
      status: "issued",
      idempotencyKey: key,
      requestFingerprint,
      expiresAt: expiresAt.toISOString(),
      completionFingerprint: null,
      quotaOriginalBytesCommitted: 0,
      quotaAssetCountCommitted: 0,
    };
    const asset: MediaAssetProjection = {
      ...scope,
      assetId,
      version: 1,
      status: "pending_upload",
      visibility,
      filename: parsed.filename,
      declaredMime: parsed.declaredMime,
      sniffedMime: null,
      byteSize: parsed.declaredBytes,
      width: null,
      height: null,
      sha256: null,
      originalObjectKey: objectKey,
      processingFingerprint: null,
      scannerVerdict: null,
      variants: [],
      collectionId: null,
      tags: [],
      rightsMetadata: {
        license: null,
        source: null,
        photographer: null,
        consentReference: null,
        publishAllowed: false,
        expiresAt: null,
      },
      createdAt: now.toISOString(),
      trashedAt: null,
      retentionUntil: null,
      deletedAt: null,
    };
    await repository.insertUpload(session);
    await repository.insertAsset(asset);
    await repository.appendEvent(
      scope,
      event({
        type: "upload_intent_issued",
        assetId,
        uploadId,
        actor,
        metadata: {
          declaredBytes: parsed.declaredBytes,
          declaredMime: parsed.declaredMime,
          visibility,
          requestFingerprint,
        },
      })
    );
    const authorization = await dependencies.storage.createUploadIntent({
      ...scope,
      uploadId,
      objectKey,
      byteSize: parsed.declaredBytes,
      contentType: parsed.declaredMime,
      expiresAt,
    });
    return { session, authorization, replayed: false };
  });
}

export async function requestBulkMediaUploadIntents(
  dependencies: { repository: MediaVaultRepository; storage: MediaStoragePort },
  actor: MediaActor,
  requests: MediaUploadRequest[],
  now = new Date()
) {
  if (
    !Array.isArray(requests) ||
    requests.length < 1 ||
    requests.length > MEDIA_LIMITS.maxBulkCount
  )
    throw createError({
      statusCode: 413,
      statusMessage: `Bulk upload accepts 1–${MEDIA_LIMITS.maxBulkCount} assets.`,
    });
  const parsed = requests.map(request => validateUploadDeclaration(request));
  const total = parsed.reduce((sum, item) => sum + item.declaredBytes, 0);
  if (total > MEDIA_LIMITS.maxBulkBytes)
    throw createError({
      statusCode: 413,
      statusMessage: "Bulk upload exceeds the bounded aggregate byte limit.",
    });
  if (
    new Set(requests.map(item => item.idempotencyKey)).size !== requests.length
  )
    conflict("Bulk upload idempotency keys must be unique.");
  return dependencies.repository.transaction(async transaction => {
    let joined: MediaVaultRepository;
    joined = { ...transaction, transaction: async work => work(joined) };
    const results = [];
    for (const request of requests)
      results.push(
        await requestMediaUploadIntent(
          { ...dependencies, repository: joined },
          actor,
          request,
          now
        )
      );
    return { results, totalDeclaredBytes: total };
  });
}

export async function requestMediaReplacementIntent(
  dependencies: { repository: MediaVaultRepository; storage: MediaStoragePort },
  actor: MediaActor,
  assetId: string,
  raw: MediaUploadRequest,
  now = new Date()
) {
  assertActor(actor, actor, true);
  const current = await dependencies.repository.findAsset(actor, assetId);
  if (!current || current.status !== "ready")
    conflict("Only a ready media asset can receive a replacement version.");
  const parsed = validateUploadDeclaration(raw);
  const idempotencyKey = idempotency(raw.idempotencyKey);
  if (!["public", "private", "internal"].includes(raw.visibility))
    invalid("Media visibility is invalid.");
  const requestFingerprint = stableFingerprint({
    version: "media-replacement-request-v1",
    ownerUserId: actor.ownerUserId,
    projectId: actor.projectId,
    assetId,
    parentVersion: current.version,
    ...parsed,
    visibility: raw.visibility,
  });
  return dependencies.repository.transaction(async repository => {
    const replay = await repository.findUploadByIdempotency(
      actor,
      idempotencyKey
    );
    if (replay) {
      if (
        replay.requestFingerprint !== requestFingerprint ||
        replay.assetId !== assetId
      )
        conflict(
          "Media replacement idempotency key collided with a different request."
        );
      return {
        session: replay,
        authorization: await dependencies.storage.createUploadIntent({
          ...actor,
          uploadId: replay.uploadId,
          objectKey: replay.objectKey,
          byteSize: replay.declaredBytes,
          contentType: replay.declaredMime,
          expiresAt: new Date(replay.expiresAt),
        }),
        replayed: true,
        parentVersion: current.version,
      };
    }
    await repository.reserveQuota(actor, {
      idempotencyKey,
      requestFingerprint,
      delta: uploadQuota(parsed.declaredBytes, 0),
    });
    const uploadId = randomUUID();
    const expiresAt = new Date(now.getTime() + MEDIA_LIMITS.uploadTtlMs);
    const objectKey = mediaObjectKey(actor, {
      kind: "upload",
      identity: uploadId,
      extension: extensionForMime(parsed.declaredMime),
    });
    const session: MediaUploadSession = {
      ownerUserId: actor.ownerUserId,
      projectId: actor.projectId,
      uploadId,
      assetId,
      objectKey,
      filename: parsed.filename,
      declaredMime: parsed.declaredMime,
      declaredBytes: parsed.declaredBytes,
      visibility: raw.visibility,
      status: "issued",
      idempotencyKey,
      requestFingerprint,
      expiresAt: expiresAt.toISOString(),
      completionFingerprint: null,
      quotaOriginalBytesCommitted: 0,
      quotaAssetCountCommitted: 0,
    };
    await repository.insertUpload(session);
    await repository.appendEvent(
      actor,
      event({
        type: "media_replacement_intent_issued",
        assetId,
        uploadId,
        actor,
        metadata: {
          parentVersion: current.version,
          declaredBytes: parsed.declaredBytes,
          requestFingerprint,
        },
      })
    );
    return {
      session,
      authorization: await dependencies.storage.createUploadIntent({
        ...actor,
        uploadId,
        objectKey,
        byteSize: parsed.declaredBytes,
        contentType: parsed.declaredMime,
        expiresAt,
      }),
      replayed: false,
      parentVersion: current.version,
    };
  });
}

export async function completeMediaUpload(
  dependencies: {
    repository: MediaVaultRepository;
    storage: MediaStoragePort;
    scanner: MediaSecurityScanner;
    processor: MediaImageProcessor;
  },
  actor: MediaActor,
  input: {
    uploadId: string;
    expectedSha256?: string;
    transformation?: unknown;
  },
  now = new Date()
) {
  const scope = { ownerUserId: actor.ownerUserId, projectId: actor.projectId };
  assertActor(actor, scope, true);
  if (
    typeof input.uploadId !== "string" ||
    !/^[a-f0-9-]{36}$/iu.test(input.uploadId)
  )
    invalid("Media upload identity is invalid.");
  if (
    input.expectedSha256 !== undefined &&
    !/^[a-f0-9]{64}$/iu.test(input.expectedSha256)
  )
    invalid("Expected media SHA-256 is invalid.");
  const claimed = await dependencies.repository.transaction(
    async repository => {
      const session = await repository.findUploadById(scope, input.uploadId);
      if (!session)
        throw createError({
          statusCode: 404,
          statusMessage: "Media upload session was not found.",
        });
      if (session.status === "completed")
        return { session, replayed: true, expired: false as const };
      if (session.status !== "issued")
        conflict(
          "Media upload session cannot be completed from its current state."
        );
      const targetStatus =
        new Date(session.expiresAt).getTime() <= now.getTime()
          ? "expired"
          : "completing";
      const won = await repository.claimUploadStatus(
        scope,
        session.uploadId,
        ["issued"],
        targetStatus
      );
      if (!won) {
        const durable = await repository.findUploadById(
          scope,
          session.uploadId
        );
        if (durable?.status === "completed")
          return { session: durable, replayed: true, expired: false as const };
        if (durable?.status === "completing")
          conflict("Media upload completion is already in progress.");
        conflict(
          "Media upload session changed concurrently and was not claimed."
        );
      }
      const updated = await repository.findUploadById(scope, session.uploadId);
      if (!updated)
        conflict("Claimed media upload session could not be reloaded.");
      if (targetStatus === "expired")
        return { session: updated, replayed: false, expired: true as const };
      return { session: updated, replayed: false, expired: false as const };
    }
  );
  if (claimed.expired) {
    const cleanup = await deleteOrQueueMediaObjects(
      dependencies,
      scope,
      `expired-upload:${claimed.session.uploadId}`,
      [claimed.session.objectKey]
    );
    await dependencies.repository.transaction(async repository => {
      await repository.releaseQuota(scope, {
        idempotencyKey: claimed.session.idempotencyKey,
        requestFingerprint: claimed.session.requestFingerprint,
      });
      await repository.appendEvent(
        scope,
        event({
          type: "expired_upload_deleted",
          assetId: claimed.session.assetId,
          uploadId: claimed.session.uploadId,
          actor,
          metadata: {
            deletionReceiptReferences: cleanup.receipts.map(item => item.receiptReference),
            cleanupQueued: cleanup.queuedObjectKeys.length > 0,
          },
        })
      );
    });
    conflict("Media upload session has expired.");
  }
  if (claimed.replayed) {
    const asset = await dependencies.repository.findAsset(
      scope,
      claimed.session.assetId
    );
    if (!asset) conflict("Completed media upload has no asset projection.");
    return { asset, replayed: true, deduplicated: false };
  }
  const session = claimed.session;
  const cleanupCandidates = [session.objectKey];
  try {
    const priorAsset = await dependencies.repository.findAsset(
      scope,
      session.assetId
    );
    if (!priorAsset)
      conflict("Media upload has no tenant-scoped asset authority.");
    const replacement = priorAsset.status !== "pending_upload";
    const head = await dependencies.storage.completeUpload({
      ...scope,
      uploadId: session.uploadId,
      objectKey: session.objectKey,
      byteSize: session.declaredBytes,
      contentType: session.declaredMime,
    });
    if (
      head.byteSize !== session.declaredBytes ||
      head.byteSize < 1 ||
      head.byteSize > MEDIA_LIMITS.maxFileBytes
    )
      throw createError({
        statusCode: 422,
        statusMessage:
          "Stored media size does not match the authorized upload.",
      });
    if (
      dependencies.storage.kind !== "local_dev" &&
      head.contentType !== session.declaredMime
    )
      throw createError({
        statusCode: 422,
        statusMessage:
          "Stored media Content-Type does not match the signed upload session.",
      });
    if (dependencies.storage.kind === "s3_compatible") {
      const metadata = Object.fromEntries(
        Object.entries(head.metadata).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ])
      );
      if (
        metadata.uploadid !== session.uploadId ||
        metadata.ownerid !== String(scope.ownerUserId) ||
        metadata.projectid !== String(scope.projectId)
      )
        throw createError({
          statusCode: 422,
          statusMessage:
            "Stored media metadata does not match the signed tenant upload authority.",
        });
    }
    const bytes = await dependencies.storage.readForProcessing({
      ...scope,
      objectKey: session.objectKey,
      maxBytes: MEDIA_LIMITS.maxFileBytes,
    });
    if (bytes.byteLength !== head.byteSize)
      conflict(
        "Stored media read length is inconsistent with object metadata."
      );
    const actualSha256 = hashBytes(bytes);
    if (
      input.expectedSha256 &&
      input.expectedSha256.toLowerCase() !== actualSha256
    )
      throw createError({
        statusCode: 422,
        statusMessage: "Stored media hash does not match the completion claim.",
      });
    const securityInspection = inspectMediaBytes(bytes);
    if (securityInspection.mime !== session.declaredMime)
      throw createError({
        statusCode: 422,
        statusMessage:
          "Stored media magic bytes do not match the declared MIME.",
      });
    const decoded = await dependencies.processor.inspect(bytes);
    const dimensionsAgree =
      (decoded.width === securityInspection.width &&
        decoded.height === securityInspection.height) ||
      Boolean(
        decoded.orientation &&
          decoded.orientation >= 5 &&
          decoded.orientation <= 8 &&
          decoded.width === securityInspection.height &&
          decoded.height === securityInspection.width
      );
    if (
      decoded.mime !== securityInspection.mime ||
      !dimensionsAgree ||
      decoded.frameCount < 1 ||
      decoded.frameCount > 100
    )
      conflict(
        "Image decoder and security inspection disagree on media identity."
      );
    const inspection = {
      ...decoded,
      hasExif: decoded.hasExif || securityInspection.hasExif,
      hasGps: decoded.hasGps || securityInspection.hasGps,
    };
    const duplicate = await dependencies.repository.findReadyAssetByHash(
      scope,
      actualSha256
    );
    if (replacement && duplicate?.assetId === session.assetId) {
      const deletion = await dependencies.storage.deleteObject({
        ...scope,
        objectKey: session.objectKey,
      });
      const completionFingerprint = stableFingerprint({
        version: "media-replacement-noop-v1",
        assetId: session.assetId,
        parentVersion: priorAsset.version,
        actualSha256,
      });
      await dependencies.repository.transaction(async repository => {
        await repository.updateUpload(scope, session.uploadId, {
          status: "completed",
          completionFingerprint,
          quotaOriginalBytesCommitted: 0,
          quotaAssetCountCommitted: 0,
        });
        await repository.settleQuota(scope, {
          idempotencyKey: session.idempotencyKey,
          requestFingerprint: session.requestFingerprint,
          committed: {
            ...zeroQuota(),
            uploadBytes: session.declaredBytes,
            processingCount: 1,
          },
        });
        await repository.appendEvent(
          scope,
          event({
            type: "media_replacement_identical_noop",
            assetId: session.assetId,
            uploadId: session.uploadId,
            actor,
            metadata: {
              parentVersion: priorAsset.version,
              deletionReceiptReference: deletion.receiptReference,
            },
          })
        );
      });
      return { asset: priorAsset, replayed: false, deduplicated: true };
    }
    if (duplicate && duplicate.assetId !== session.assetId) {
      const deletion = await dependencies.storage.deleteObject({
        ...scope,
        objectKey: session.objectKey,
      });
      await dependencies.repository.transaction(async repository => {
        await repository.updateUpload(scope, session.uploadId, {
          status: "completed",
          completionFingerprint: stableFingerprint({
            actualSha256,
            duplicate: duplicate.assetId,
          }),
          quotaOriginalBytesCommitted: 0,
          quotaAssetCountCommitted: 0,
        });
        await repository.updateAsset(scope, session.assetId, {
          status: "deleted",
          sha256: actualSha256,
          sniffedMime: inspection.mime,
          deletedAt: now.toISOString(),
        });
        await repository.settleQuota(scope, {
          idempotencyKey: session.idempotencyKey,
          requestFingerprint: session.requestFingerprint,
          committed: {
            ...zeroQuota(),
            uploadBytes: session.declaredBytes,
            processingCount: 1,
          },
        });
        await repository.appendEvent(
          scope,
          event({
            type: "upload_deduplicated",
            assetId: duplicate.assetId,
            uploadId: session.uploadId,
            actor,
            metadata: {
              duplicateWithinTenant: true,
              deletionReceiptReference: deletion.receiptReference,
            },
          })
        );
      });
      return { asset: duplicate, replayed: false, deduplicated: true };
    }
    const scan = await dependencies.scanner.scan({
      bytes,
      sha256: actualSha256,
      tenant: scope,
    });
    const processingFingerprint = stableFingerprint({
      version: "media-processing-v1",
      ...scope,
      assetId: session.assetId,
      actualSha256,
      inspection,
      scannerVerdict: scan.verdict,
    });
    if (scan.verdict !== "passed" && replacement) {
      const cleanup = await deleteOrQueueMediaObjects(
        dependencies,
        scope,
        `replacement-rejected:${session.uploadId}`,
        [session.objectKey]
      );
      await dependencies.repository.transaction(async repository => {
        await repository.updateUpload(scope, session.uploadId, {
          status: "rejected",
          completionFingerprint: processingFingerprint,
          quotaOriginalBytesCommitted: 0,
          quotaAssetCountCommitted: 0,
        });
        await repository.settleQuota(scope, {
          idempotencyKey: session.idempotencyKey,
          requestFingerprint: session.requestFingerprint,
          committed: {
            originalBytes: 0,
            assetCount: 0,
            uploadBytes: session.declaredBytes,
            processingCount: 1,
          },
        });
        await repository.appendEvent(
          scope,
          event({
            type: "media_replacement_quarantined",
            assetId: session.assetId,
            uploadId: session.uploadId,
            actor,
            metadata: {
              retainedVersion: priorAsset.version,
              verdict: scan.verdict,
              reasonCode: scan.reasonCode,
              publicUse: false,
              cleanupReceipts: cleanup.receipts.map(item => item.receiptReference),
              cleanupQueued: cleanup.queuedObjectKeys.length > 0,
            },
          })
        );
      });
      return {
        asset: priorAsset,
        replayed: false,
        deduplicated: false,
        replacementRejected: true,
      };
    }
    if (scan.verdict !== "passed") {
      const asset = await dependencies.repository.transaction(
        async repository => {
          const updated = await repository.updateAsset(scope, session.assetId, {
            status: "quarantined",
            sniffedMime: inspection.mime,
            width: inspection.width,
            height: inspection.height,
            sha256: actualSha256,
            processingFingerprint,
            scannerVerdict: scan.verdict,
          });
          if (!updated)
            conflict("Quarantined media asset could not be persisted.");
          await repository.updateUpload(scope, session.uploadId, {
            status: "completed",
            completionFingerprint: processingFingerprint,
            quotaOriginalBytesCommitted: session.declaredBytes,
            quotaAssetCountCommitted: 1,
          });
          await repository.settleQuota(scope, {
            idempotencyKey: session.idempotencyKey,
            requestFingerprint: session.requestFingerprint,
            committed: uploadQuota(session.declaredBytes, 1),
          });
          await repository.recordProcessingRun(scope, {
            assetId: session.assetId,
            status: "quarantined",
            scannerVerdict: scan.verdict,
            processingFingerprint,
            errorCode: scan.reasonCode,
          });
          await repository.appendEvent(
            scope,
            event({
              type: "media_quarantined",
              assetId: session.assetId,
              uploadId: session.uploadId,
              actor,
              metadata: {
                verdict: scan.verdict,
                reasonCode: scan.reasonCode,
                scannerReference: scan.scannerReference,
                publicUse: false,
              },
            })
          );
          return updated;
        }
      );
      return { asset, replayed: false, deduplicated: false };
    }
    const transformation = validateTransformation(
      input.transformation,
      inspection.width,
      inspection.height
    );
    const variants = await dependencies.processor.produceVariants({
      bytes,
      inspection,
      transformation,
    });
    const required = [
      "thumbnail",
      "small",
      "medium",
      "large",
      "original_policy",
    ];
    if (
      variants.length !== required.length ||
      new Set(variants.map(item => item.key)).size !== required.length ||
      !required.every(key => variants.some(item => item.key === key))
    )
      conflict(
        "Image processor did not produce the required deterministic variant set."
      );
    const projections: MediaVariantProjection[] = [];
    for (const variant of variants) {
      if (
        variant.sha256 !== hashBytes(variant.bytes) ||
        variant.width < 1 ||
        variant.height < 1 ||
        variant.width > MEDIA_LIMITS.maxDimension ||
        variant.height > MEDIA_LIMITS.maxDimension
      )
        conflict("Image processor variant identity is invalid.");
      const objectKey = mediaObjectKey(scope, {
        kind: "asset",
        identity: `${session.assetId}-${variant.key}-${variant.sha256.slice(0, 12)}`,
        extension: variant.format === "jpeg" ? "jpg" : variant.format,
      });
      const stored = await dependencies.storage.writeVariant({
        ...scope,
        objectKey,
        bytes: variant.bytes,
        contentType: `image/${variant.format}`,
        sha256: variant.sha256,
      });
      cleanupCandidates.push(stored.objectKey);
      projections.push({
        key: variant.key,
        format: variant.format,
        width: variant.width,
        height: variant.height,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        objectKey: stored.objectKey,
        transformation: variant.transformation,
      });
    }
    const asset = await dependencies.repository.transaction(
      async repository => {
        const displayVariant = projections.find(
          item => item.key === "original_policy"
        )!;
        const replacementProjection: MediaAssetProjection = {
          ...priorAsset,
          version: priorAsset.version + 1,
          status: "ready",
          visibility: session.visibility,
          filename: session.filename,
          declaredMime: session.declaredMime,
          sniffedMime: inspection.mime,
          byteSize: bytes.byteLength,
          width: displayVariant.width,
          height: displayVariant.height,
          sha256: actualSha256,
          originalObjectKey: session.objectKey,
          processingFingerprint,
          scannerVerdict: scan.verdict,
          variants: projections,
          createdAt: now.toISOString(),
          trashedAt: null,
          retentionUntil: null,
          deletedAt: null,
        };
        const updated = replacement
          ? await repository.appendReplacementVersion(
              scope,
              replacementProjection
            )
          : await repository.updateAsset(scope, session.assetId, {
              status: "ready",
              sniffedMime: inspection.mime,
              byteSize: bytes.byteLength,
              width: displayVariant.width,
              height: displayVariant.height,
              sha256: actualSha256,
              processingFingerprint,
              scannerVerdict: scan.verdict,
              variants: projections,
            });
        if (!updated) conflict("Processed media asset could not be persisted.");
        await repository.updateUpload(scope, session.uploadId, {
          status: "completed",
          completionFingerprint: processingFingerprint,
          quotaOriginalBytesCommitted: bytes.byteLength,
          quotaAssetCountCommitted: replacement ? 0 : 1,
        });
        await repository.settleQuota(scope, {
          idempotencyKey: session.idempotencyKey,
          requestFingerprint: session.requestFingerprint,
          committed: uploadQuota(bytes.byteLength, replacement ? 0 : 1),
        });
        await repository.recordProcessingRun(scope, {
          assetId: session.assetId,
          status: "succeeded",
          scannerVerdict: "passed",
          processingFingerprint,
          errorCode: null,
        });
        await repository.appendEvent(
          scope,
          event({
            type: replacement ? "media_replacement_ready" : "media_ready",
            assetId: session.assetId,
            uploadId: session.uploadId,
            actor,
            metadata: {
              version: updated.version,
              parentVersion: replacement ? priorAsset.version : null,
              sha256: actualSha256,
              inspection,
              processingFingerprint,
              variantHashes: projections.map(item => item.sha256),
              metadataScrubbed: transformation.stripMetadata,
            },
          })
        );
        return updated;
      }
    );
    return { asset, replayed: false, deduplicated: false };
  } catch (error) {
    const current = await dependencies.repository.findAsset(
      scope,
      session.assetId
    );
    const preserveReadyReplacement = current?.status === "ready";
    await dependencies.repository.transaction(async repository => {
      const rejected = await repository.claimUploadStatus(
        scope,
        session.uploadId,
        ["completing"],
        "rejected"
      );
      if (!rejected)
        conflict(
          "Media upload failure finalization lost its completion claim."
        );
      await repository.releaseQuota(scope, {
        idempotencyKey: session.idempotencyKey,
        requestFingerprint: session.requestFingerprint,
      });
      if (!preserveReadyReplacement)
        await repository.updateAsset(scope, session.assetId, {
          status: "quarantined",
        });
      await repository.appendEvent(
        scope,
        event({
          type: preserveReadyReplacement
            ? "media_replacement_rejected"
            : "media_processing_rejected",
          assetId: session.assetId,
          uploadId: session.uploadId,
          actor,
          metadata: {
            retainedVersion: preserveReadyReplacement ? current?.version : null,
            reasonCode: "MEDIA_VALIDATION_OR_PROCESSING_FAILED",
            publicUse: false,
          },
        })
      );
    });
    await deleteOrQueueMediaObjects(
      dependencies,
      scope,
      `upload-failure:${session.uploadId}`,
      cleanupCandidates
    );
    throw error;
  }
}

export async function listMediaAssets(
  repository: MediaVaultRepository,
  actor: MediaActor,
  options: {
    query?: string;
    status?: string;
    visibility?: MediaVisibility;
    limit?: number;
    beforeCreatedAt?: string;
    beforeAssetId?: string;
  } = {}
) {
  assertActor(actor, actor);
  const query = options.query?.trim().normalize("NFKC").toLowerCase().slice(0, 120) || "";
  const assets = await repository.listAssets(actor, {
    limit: options.limit,
    beforeCreatedAt: options.beforeCreatedAt,
    beforeAssetId: options.beforeAssetId,
  });
  return assets
    .filter(
      asset =>
        (!query || asset.filename.normalize("NFKC").toLowerCase().includes(query)) &&
        (!options.status || asset.status === options.status) &&
        (!options.visibility || asset.visibility === options.visibility)
    )
    .slice(0, Math.max(1, Math.min(100, options.limit || 50)));
}
export async function createPrivateMediaRead(
  storage: MediaStoragePort,
  repository: MediaVaultRepository,
  actor: MediaActor,
  assetId: string,
  variantKey = "original_policy",
  now = new Date()
) {
  assertActor(actor, actor);
  const asset = await repository.findAsset(actor, assetId);
  if (!asset || asset.status !== "ready")
    throw createError({
      statusCode: 404,
      statusMessage: "Ready media asset was not found in this site.",
    });
  const objectKey =
    variantKey === "original"
      ? asset.originalObjectKey
      : asset.variants.find(item => item.key === variantKey)?.objectKey;
  if (!objectKey)
    throw createError({
      statusCode: 404,
      statusMessage: "Media object was not found.",
    });
  const authorization = await storage.createSignedRead({
    ...actor,
    objectKey,
    expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
  });
  await repository.appendEvent(
    actor,
    event({
      type:
        variantKey === "original"
          ? "media_original_download_authorized"
          : "media_variant_read_authorized",
      assetId,
      actor,
      metadata: { variantKey, expiresAt: authorization.expiresAt },
    })
  );
  return authorization;
}

function normalizedRights(
  input: unknown,
  current: MediaRightsMetadata
): MediaRightsMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("Media rights metadata must be an object.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      key =>
        ![
          "license",
          "source",
          "photographer",
          "consentReference",
          "publishAllowed",
          "expiresAt",
        ].includes(key)
    )
  )
    invalid("Media rights metadata contains unknown fields.");
  const text = (key: string, max: number) =>
    value[key] === undefined
      ? (current[key as keyof MediaRightsMetadata] as string | null)
      : value[key] === null
        ? null
        : typeof value[key] === "string" && value[key]!.trim().length <= max
          ? value[key]!.trim()
          : invalid(`Media rights ${key} is invalid.`);
  const expiresAt = text("expiresAt", 40);
  if (
    expiresAt !== null &&
    (!/^\d{4}-\d{2}-\d{2}T/u.test(expiresAt) ||
      !Number.isFinite(Date.parse(expiresAt)))
  )
    invalid("Media rights expiry is invalid.");
  const publishAllowed =
    value.publishAllowed === undefined
      ? current.publishAllowed
      : value.publishAllowed === true || value.publishAllowed === false
        ? value.publishAllowed
        : invalid("Media publish permission must be explicit.");
  return {
    license: text("license", 160),
    source: text("source", 500),
    photographer: text("photographer", 160),
    consentReference: text("consentReference", 255),
    publishAllowed,
    expiresAt,
  };
}

export async function updateMediaGovernance(
  repository: MediaVaultRepository,
  actor: MediaActor,
  input: {
    assetId: string;
    visibility?: MediaVisibility;
    rightsMetadata?: unknown;
  }
) {
  assertActor(actor, actor, true);
  const asset = await repository.findAsset(actor, input.assetId);
  if (!asset || ["deleted", "deletion_pending"].includes(asset.status))
    throw createError({
      statusCode: 404,
      statusMessage: "Media asset was not found in this site.",
    });
  const visibility =
    input.visibility === undefined
      ? asset.visibility
      : ["public", "private", "internal"].includes(input.visibility)
        ? input.visibility
        : invalid("Media visibility is invalid.");
  const rightsMetadata =
    input.rightsMetadata === undefined
      ? asset.rightsMetadata
      : normalizedRights(input.rightsMetadata, asset.rightsMetadata);
  if (visibility === "public" && !rightsMetadata.publishAllowed)
    conflict("Public media requires explicit publish-allowed rights metadata.");
  if (
    rightsMetadata.expiresAt &&
    Date.parse(rightsMetadata.expiresAt) <= Date.now() &&
    visibility === "public"
  )
    conflict("Expired media rights cannot be made public.");
  const updated = await repository.updateAsset(actor, asset.assetId, {
    visibility,
    rightsMetadata,
  });
  await repository.appendEvent(
    actor,
    event({
      type: "media_governance_updated",
      assetId: asset.assetId,
      actor,
      before: stableFingerprint({
        visibility: asset.visibility,
        rightsMetadata: asset.rightsMetadata,
      }),
      after: stableFingerprint({ visibility, rightsMetadata }),
      metadata: {
        visibility,
        publishAllowed: rightsMetadata.publishAllowed,
        expiresAt: rightsMetadata.expiresAt,
      },
    })
  );
  return updated;
}

export async function retryMediaProcessing(
  dependencies: {
    repository: MediaVaultRepository;
    storage: MediaStoragePort;
    scanner: MediaSecurityScanner;
    processor: MediaImageProcessor;
  },
  actor: MediaActor,
  input: { assetId: string; transformation?: unknown },
  now = new Date()
) {
  assertActor(actor, actor, true);
  const before = await dependencies.repository.findAsset(actor, input.assetId);
  if (!before || !["quarantined", "failed"].includes(before.status))
    conflict("Only quarantined or failed media can be retried.");
  if (!before.sha256 || !before.sniffedMime || !before.width || !before.height)
    conflict("Media validation identity is incomplete and cannot be retried.");
  const quotaKey =
    `retry:${before.assetId}:${before.version}:${before.processingFingerprint || before.sha256}`.slice(
      0,
      128
    );
  const quotaFingerprint = stableFingerprint({
    version: "media-retry-quota-v1",
    assetId: before.assetId,
    versionNumber: before.version,
    source: before.processingFingerprint || before.sha256,
  });
  await dependencies.repository.transaction(async repository => {
    await repository.reserveQuota(actor, {
      idempotencyKey: quotaKey,
      requestFingerprint: quotaFingerprint,
      delta: { ...zeroQuota(), processingCount: 1 },
    });
    if (
      !(await repository.claimAssetStatus(
        actor,
        before.assetId,
        ["quarantined", "failed"],
        "processing"
      ))
    )
      conflict("Media processing is already claimed.");
  });
  try {
    const bytes = await dependencies.storage.readForProcessing({
      ...actor,
      objectKey: before.originalObjectKey,
      maxBytes: MEDIA_LIMITS.maxFileBytes,
    });
    if (hashBytes(bytes) !== before.sha256)
      conflict("Immutable original hash changed before retry.");
    const inspection = await dependencies.processor.inspect(bytes);
    if (
      inspection.mime !== before.sniffedMime ||
      inspection.width !== before.width ||
      inspection.height !== before.height
    )
      conflict("Immutable original dimensions or MIME changed before retry.");
    const scan = await dependencies.scanner.scan({
      bytes,
      sha256: before.sha256,
      tenant: actor,
    });
    if (scan.verdict !== "passed") {
      const retryFingerprint = stableFingerprint({
        version: "media-processing-retry-quarantine-v1",
        assetId: before.assetId,
        sha256: before.sha256,
        verdict: scan.verdict,
      });
      const quarantined = await dependencies.repository.transaction(
        async repository => {
          const updated = await repository.updateAsset(actor, before.assetId, {
            status: "quarantined",
            scannerVerdict: scan.verdict,
          });
          await repository.settleQuota(actor, {
            idempotencyKey: quotaKey,
            requestFingerprint: quotaFingerprint,
            committed: { ...zeroQuota(), processingCount: 1 },
          });
          await repository.recordProcessingRun(actor, {
            assetId: before.assetId,
            status: "quarantined",
            scannerVerdict: scan.verdict,
            processingFingerprint: retryFingerprint,
            errorCode: scan.reasonCode,
          });
          await repository.appendEvent(
            actor,
            event({
              type: "media_processing_retry_quarantined",
              assetId: before.assetId,
              actor,
              metadata: {
                verdict: scan.verdict,
                reasonCode: scan.reasonCode,
                publicUse: false,
              },
            })
          );
          return updated;
        }
      );
      return { asset: quarantined, retried: true, ready: false };
    }
    const transformation = validateTransformation(
      input.transformation,
      inspection.width,
      inspection.height
    );
    const variants = await dependencies.processor.produceVariants({
      bytes,
      inspection,
      transformation,
    });
    const required = [
      "thumbnail",
      "small",
      "medium",
      "large",
      "original_policy",
    ];
    if (
      variants.length !== required.length ||
      new Set(variants.map(item => item.key)).size !== required.length ||
      !required.every(key => variants.some(item => item.key === key))
    )
      conflict(
        "Image processor retry did not produce the required variant set."
      );
    const projections: MediaVariantProjection[] = [];
    for (const variant of variants) {
      if (variant.sha256 !== hashBytes(variant.bytes))
        conflict("Retried variant hash is invalid.");
      const objectKey = mediaObjectKey(actor, {
        kind: "asset",
        identity: `${before.assetId}-${variant.key}-${variant.sha256.slice(0, 12)}`,
        extension: variant.format === "jpeg" ? "jpg" : variant.format,
      });
      const stored = await dependencies.storage.writeVariant({
        ...actor,
        objectKey,
        bytes: variant.bytes,
        contentType: `image/${variant.format}`,
        sha256: variant.sha256,
      });
      projections.push({
        key: variant.key,
        format: variant.format,
        width: variant.width,
        height: variant.height,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        objectKey: stored.objectKey,
        transformation: variant.transformation,
      });
    }
    const displayVariant = projections.find(
      item => item.key === "original_policy"
    )!;
    const processingFingerprint = stableFingerprint({
      version: "media-processing-retry-v1",
      ownerUserId: actor.ownerUserId,
      projectId: actor.projectId,
      assetId: before.assetId,
      sha256: before.sha256,
      transformation,
      variantHashes: projections.map(item => item.sha256),
    });
    const ready = await dependencies.repository.transaction(
      async repository => {
        const updated = await repository.updateAsset(actor, before.assetId, {
          status: "ready",
          width: displayVariant.width,
          height: displayVariant.height,
          scannerVerdict: "passed",
          processingFingerprint,
          variants: projections,
        });
        await repository.settleQuota(actor, {
          idempotencyKey: quotaKey,
          requestFingerprint: quotaFingerprint,
          committed: { ...zeroQuota(), processingCount: 1 },
        });
        await repository.recordProcessingRun(actor, {
          assetId: before.assetId,
          status: "succeeded",
          scannerVerdict: "passed",
          processingFingerprint,
          errorCode: null,
        });
        await repository.appendEvent(
          actor,
          event({
            type: "media_processing_retry_succeeded",
            assetId: before.assetId,
            actor,
            metadata: {
              processingFingerprint,
              variantHashes: projections.map(item => item.sha256),
              metadataScrubbed: true,
            },
          })
        );
        return updated;
      }
    );
    return { asset: ready, retried: true, ready: true };
  } catch (error) {
    await dependencies.repository
      .transaction(async repository => {
        await repository.updateAsset(actor, before.assetId, {
          status: "quarantined",
        });
        await repository.settleQuota(actor, {
          idempotencyKey: quotaKey,
          requestFingerprint: quotaFingerprint,
          committed: { ...zeroQuota(), processingCount: 1 },
        });
        await repository.appendEvent(
          actor,
          event({
            type: "media_processing_retry_failed",
            assetId: before.assetId,
            actor,
            metadata: {
              reasonCode: "RETRY_VALIDATION_OR_PROCESSING_FAILED",
              publicUse: false,
            },
          })
        );
      })
      .catch(() => null);
    throw error;
  }
}

function cropForAspect(
  width: number,
  height: number,
  aspect: NonNullable<MediaTransformation["crop"]>["aspect"],
  focalPoint: { x: number; y: number }
) {
  if (aspect === "free") return { x: 0, y: 0, width, height, aspect };
  const ratios: Record<string, number> = {
    "1:1": 1,
    "4:3": 4 / 3,
    "3:2": 3 / 2,
    "16:9": 16 / 9,
    portrait: 3 / 4,
  };
  const ratio = ratios[aspect]!;
  let cropWidth = width;
  let cropHeight = Math.round(width / ratio);
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = Math.round(height * ratio);
  }
  const x = Math.max(
    0,
    Math.min(
      width - cropWidth,
      Math.round(focalPoint.x * width - cropWidth / 2)
    )
  );
  const y = Math.max(
    0,
    Math.min(
      height - cropHeight,
      Math.round(focalPoint.y * height - cropHeight / 2)
    )
  );
  return { x, y, width: cropWidth, height: cropHeight, aspect };
}

export async function createMediaTransformationVersion(
  dependencies: {
    repository: MediaVaultRepository;
    storage: MediaStoragePort;
    processor: MediaImageProcessor;
  },
  actor: MediaActor,
  input: {
    assetId: string;
    aspect: NonNullable<MediaTransformation["crop"]>["aspect"];
    focalPoint: { x: number; y: number };
    rotation?: 0 | 90 | 180 | 270;
    expectedAssetVersion: number;
    idempotencyKey: string;
  },
  now = new Date()
) {
  assertActor(actor, actor, true);
  idempotency(input.idempotencyKey);
  const asset = await dependencies.repository.findAsset(actor, input.assetId);
  if (!asset || asset.status !== "ready" || !asset.sha256)
    conflict("Only ready media can create a transformation version.");
  if (
    !["free", "1:1", "4:3", "3:2", "16:9", "portrait"].includes(input.aspect) ||
    !input.focalPoint ||
    !Number.isFinite(input.focalPoint.x) ||
    !Number.isFinite(input.focalPoint.y) ||
    input.focalPoint.x < 0 ||
    input.focalPoint.x > 1 ||
    input.focalPoint.y < 0 ||
    input.focalPoint.y > 1 ||
    ![0, 90, 180, 270].includes(input.rotation || 0)
  )
    invalid("Media transformation preset, focal point or rotation is invalid.");
  const requestFingerprint = stableFingerprint({
    version: "media-transform-request-v1",
    ownerUserId: actor.ownerUserId,
    projectId: actor.projectId,
    assetId: asset.assetId,
    expectedAssetVersion: input.expectedAssetVersion,
    aspect: input.aspect,
    focalPoint: input.focalPoint,
    rotation: input.rotation || 0,
  });
  const prior = await dependencies.repository.findEventByIdempotency(actor, {
    assetId: asset.assetId,
    eventType: "media_transformation_version_created",
    idempotencyKey: input.idempotencyKey,
  });
  if (prior) {
    if (prior.metadata.requestFingerprint !== requestFingerprint)
      conflict("Media transformation idempotency key collided.");
    return {
      asset: await dependencies.repository.findAsset(actor, asset.assetId),
      receipt: prior,
      replayed: true,
    };
  }
  if (asset.version !== input.expectedAssetVersion)
    conflict(
      "Media asset version is stale; transformation did not overwrite newer work."
    );
  const quotaClaim = await dependencies.repository.transaction(repository =>
    repository.reserveQuota(actor, {
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      delta: { ...zeroQuota(), processingCount: 1 },
    })
  );
  if (quotaClaim.replayed)
    conflict("Media transformation is already claimed or completed.");
  const writtenObjectKeys: string[] = [];
  try {
  const bytes = await dependencies.storage.readForProcessing({
    ...actor,
    objectKey: asset.originalObjectKey,
    maxBytes: MEDIA_LIMITS.maxFileBytes,
  });
  if (hashBytes(bytes) !== asset.sha256)
    conflict("Immutable original hash changed before transformation.");
  const inspection = await dependencies.processor.inspect(bytes);
  const transformation = validateTransformation(
    {
      crop: cropForAspect(
        inspection.width,
        inspection.height,
        input.aspect,
        input.focalPoint
      ),
      focalPoint: input.focalPoint,
      rotation: input.rotation || 0,
    },
    inspection.width,
    inspection.height
  );
  const variants = await dependencies.processor.produceVariants({
    bytes,
    inspection,
    transformation,
  });
  const required = ["thumbnail", "small", "medium", "large", "original_policy"];
  if (
    variants.length !== required.length ||
    new Set(variants.map(item => item.key)).size !== required.length ||
    !required.every(key => variants.some(item => item.key === key))
  )
    conflict("Media transformation did not produce the required variant set.");
  const projections: MediaVariantProjection[] = [];
  for (const variant of variants) {
    if (variant.sha256 !== hashBytes(variant.bytes))
      conflict("Media transformation variant hash is invalid.");
    const objectKey = mediaObjectKey(actor, {
      kind: "asset",
      identity: `${asset.assetId}-v${asset.version + 1}-${variant.key}-${variant.sha256.slice(0, 12)}`,
      extension: variant.format === "jpeg" ? "jpg" : variant.format,
    });
    const stored = await dependencies.storage.writeVariant({
      ...actor,
      objectKey,
      bytes: variant.bytes,
      contentType: `image/${variant.format}`,
      sha256: variant.sha256,
    });
    writtenObjectKeys.push(stored.objectKey);
    projections.push({
      key: variant.key,
      format: variant.format,
      width: variant.width,
      height: variant.height,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      objectKey: stored.objectKey,
      transformation: variant.transformation,
    });
  }
  const display = projections.find(item => item.key === "original_policy")!;
  const processingFingerprint = stableFingerprint({
    requestFingerprint,
    sourceSha256: asset.sha256,
    variants: projections.map(item => ({ key: item.key, sha256: item.sha256 })),
  });
  const replacement: MediaAssetProjection = {
    ...asset,
    version: asset.version + 1,
    width: display.width,
    height: display.height,
    variants: projections,
    processingFingerprint,
    createdAt: now.toISOString(),
  };
  return await dependencies.repository.transaction(async repository => {
    const updated = await repository.appendReplacementVersion(
      actor,
      replacement
    );
    if (!updated)
      conflict(
        "Media changed concurrently; transformation did not overwrite it."
      );
    await repository.settleQuota(actor, {
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      committed: { ...zeroQuota(), processingCount: 1 },
    });
    const receipt = await repository.appendEvent(
      actor,
      event({
        type: "media_transformation_version_created",
        assetId: asset.assetId,
        actor,
        metadata: {
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          parentVersion: asset.version,
          version: updated.version,
          aspect: input.aspect,
          focalPoint: input.focalPoint,
          rotation: input.rotation || 0,
          processingFingerprint,
        },
      })
    );
    return { asset: updated, receipt, replayed: false };
  });
  } catch (error) {
    await deleteOrQueueMediaObjects(
      dependencies,
      actor,
      `transformation-failure:${asset.assetId}:${input.idempotencyKey}`,
      writtenObjectKeys
    );
    await dependencies.repository
      .transaction(repository =>
        repository.releaseQuota(actor, {
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
        })
      )
      .catch(() => null);
    throw error;
  }
}
export async function trashMediaAsset(
  repository: MediaVaultRepository,
  actor: MediaActor,
  assetId: string,
  now = new Date()
) {
  assertActor(actor, actor, true);
  const asset = await repository.findAsset(actor, assetId);
  if (!asset || asset.status !== "ready")
    conflict("Only a ready media asset can move to trash.");
  const trashedAt = now.toISOString();
  const retentionUntil = new Date(
    now.getTime() + MEDIA_LIMITS.trashRetentionMs
  ).toISOString();
  const updated = await repository.updateAsset(actor, assetId, {
    status: "trashed",
    trashedAt,
    retentionUntil,
  });
  await repository.appendEvent(
    actor,
    event({
      type: "media_trashed",
      assetId,
      actor,
      metadata: { retentionUntil },
    })
  );
  return updated;
}
export async function restoreMediaAsset(
  repository: MediaVaultRepository,
  actor: MediaActor,
  assetId: string,
  now = new Date()
) {
  assertActor(actor, actor, true);
  const asset = await repository.findAsset(actor, assetId);
  if (
    !asset ||
    asset.status !== "trashed" ||
    !asset.retentionUntil ||
    Date.parse(asset.retentionUntil) <= now.getTime()
  )
    conflict("Media asset is not restorable.");
  const updated = await repository.updateAsset(actor, assetId, {
    status: "ready",
    trashedAt: null,
    retentionUntil: null,
  });
  await repository.appendEvent(
    actor,
    event({ type: "media_restored", assetId, actor })
  );
  return updated;
}
export async function permanentlyDeleteMediaAsset(
  dependencies: { repository: MediaVaultRepository; storage: MediaStoragePort },
  actor: MediaActor,
  input: { assetId: string; confirmation: string },
  now = new Date()
) {
  assertActor(actor, actor, true);
  if (!["platform_owner", "customer_admin"].includes(actor.role))
    forbidden(
      "Permanent media deletion requires platform-owner or customer-admin authority."
    );
  const asset = await dependencies.repository.findAsset(actor, input.assetId);
  if (!asset || !["trashed", "deletion_pending"].includes(asset.status))
    conflict("Only a trashed or deletion-pending asset can be permanently deleted.");
  if (input.confirmation !== `DELETE:${asset.assetId}`)
    invalid("Permanent media deletion confirmation is invalid.");
  if (!asset.retentionUntil || Date.parse(asset.retentionUntil) > now.getTime())
    conflict("Media retention window has not expired.");
  if (
    (await dependencies.repository.countActiveUsages(actor, asset.assetId)) > 0
  )
    conflict(
      "In-use media must be unbound or replaced before permanent deletion."
    );
  const originalBytes = await dependencies.repository.getOriginalBytesForAsset(
    actor,
    asset.assetId
  );
  if (asset.status === "trashed") {
    const claimed = await dependencies.repository.claimAssetStatus(
      actor,
      asset.assetId,
      ["trashed"],
      "deletion_pending"
    );
    if (!claimed) conflict("Media deletion was claimed concurrently.");
  }
  const cleanup = await deleteOrQueueMediaObjects(
    dependencies,
    actor,
    `permanent-delete:${asset.assetId}`,
    await dependencies.repository.listObjectKeys(actor, asset.assetId),
    { assetId: asset.assetId, originalBytes }
  );
  if (cleanup.queuedObjectKeys.length)
    throw createError({
      statusCode: 503,
      statusMessage:
        "Media deletion is pending durable object-storage cleanup and will retry automatically.",
    });
  return dependencies.repository.transaction(async repository => {
    const requestFingerprint = stableFingerprint({
      version: "media-permanent-delete-v1",
      ownerUserId: actor.ownerUserId,
      projectId: actor.projectId,
      assetId: asset.assetId,
      originalBytes,
    });
    await repository.creditQuota(actor, {
      idempotencyKey: `delete:${asset.assetId}`.slice(0, 128),
      requestFingerprint,
      delta: { originalBytes, assetCount: 1 },
    });
    const updated = await repository.updateAsset(actor, asset.assetId, {
      status: "deleted",
      deletedAt: now.toISOString(),
    });
    const deletionEvent = await repository.appendEvent(
      actor,
      event({
        type: "media_permanently_deleted",
        assetId: asset.assetId,
        actor,
        metadata: {
          objectReceipts: cleanup.receipts.map(item => item.receiptReference),
          objectCount: cleanup.receipts.length,
          quotaOriginalBytesReleased: originalBytes,
          quotaAssetCountReleased: 1,
        },
      })
    );
    return { asset: updated, receipt: deletionEvent };
  });
}

export function sanitizeReplacementFilename(filename: unknown): string {
  return sanitizeMediaFilename(filename);
}
