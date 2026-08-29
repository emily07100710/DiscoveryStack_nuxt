import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { createError } from "h3";
import { getDatabase } from "../../database";
import {
  managedSiteMediaAssets,
  managedSiteMediaAssetVersions,
  managedSiteMediaEvents,
  managedSiteMediaObjects,
  managedSiteMediaProcessingRuns,
  managedSiteMediaQuotaClaims,
  managedSiteMediaQuotaProjections,
  managedSiteMediaTagLinks,
  managedSiteMediaTags,
  managedSiteMediaUploadSessions,
  managedSiteMediaUsageBindings,
  managedSiteMediaVariants,
  managedSiteEditorJobs,
  managedSiteStorageConnections,
  managedSiteSubscriptions,
} from "../../database/schema";
import type {
  MediaAssetProjection,
  MediaEvent,
  MediaQuota,
  MediaTenantScope,
  MediaUploadSession,
  MediaVaultRepository,
} from "./types";
import { stableFingerprint } from "../../seo-geo-core/repository";

function dbOrThrow() {
  const database = getDatabase();
  if (!database)
    throw createError({
      statusCode: 503,
      statusMessage: "Media vault database is unavailable.",
    });
  return database;
}
function insertId(value: unknown): number {
  const id = Number((value as any)?.[0]?.insertId);
  if (!Number.isSafeInteger(id) || id < 1)
    throw createError({
      statusCode: 500,
      statusMessage: "Media vault record identity was not returned.",
    });
  return id;
}
function date(value: unknown): string | null {
  return value instanceof Date
    ? value.toISOString()
    : value
      ? new Date(value as any).toISOString()
      : null;
}
async function connectionId(
  database: any,
  scope: MediaTenantScope
): Promise<number> {
  const [row] = await database
    .select({ id: managedSiteStorageConnections.id })
    .from(managedSiteStorageConnections)
    .where(
      and(
        eq(managedSiteStorageConnections.ownerUserId, scope.ownerUserId),
        eq(managedSiteStorageConnections.projectId, scope.projectId)
      )
    )
    .limit(1);
  if (!row)
    throw createError({
      statusCode: 503,
      statusMessage:
        "Media storage connection is not configured for this site.",
    });
  return row.id;
}

const provisionalStatuses = new Set([
  "pending_upload",
  "uploaded",
  "processing",
  "quarantined",
  "failed",
]);

async function projectAssetRows(
  database: any,
  scope: MediaTenantScope,
  rows: Array<{ asset: any; version: any; originalObjectKey: string | null }>
): Promise<MediaAssetProjection[]> {
  if (!rows.length) return [];
  const versionIds = rows.map((row) => row.version.id);
  const assetIds = rows.map((row) => row.asset.assetId);
  if (new Set(assetIds).size !== rows.length || new Set(versionIds).size !== rows.length)
    throw createError({
      statusCode: 409,
      statusMessage: "Media current-version object authority is ambiguous.",
    });
  const [variants, tags, uploads] = await Promise.all([
    database
      .select({
        assetVersionId: managedSiteMediaVariants.assetVersionId,
        key: managedSiteMediaVariants.variantKey,
        format: managedSiteMediaVariants.format,
        width: managedSiteMediaVariants.width,
        height: managedSiteMediaVariants.height,
        byteSize: managedSiteMediaVariants.byteSize,
        sha256: managedSiteMediaVariants.sha256,
        objectKey: managedSiteMediaObjects.objectKey,
        transformation: managedSiteMediaVariants.transformation,
      })
      .from(managedSiteMediaVariants)
      .innerJoin(
        managedSiteMediaObjects,
        eq(managedSiteMediaVariants.mediaObjectId, managedSiteMediaObjects.id)
      )
      .where(
        and(
          eq(managedSiteMediaVariants.ownerUserId, scope.ownerUserId),
          eq(managedSiteMediaVariants.projectId, scope.projectId),
          inArray(managedSiteMediaVariants.assetVersionId, versionIds),
          isNull(managedSiteMediaObjects.deletedAt)
        )
      ),
    database
      .select({
        assetId: managedSiteMediaTagLinks.assetId,
        id: managedSiteMediaTags.id,
        name: managedSiteMediaTags.name,
        canonicalKey: managedSiteMediaTags.canonicalKey,
      })
      .from(managedSiteMediaTagLinks)
      .innerJoin(
        managedSiteMediaTags,
        eq(managedSiteMediaTagLinks.tagId, managedSiteMediaTags.id)
      )
      .where(
        and(
          eq(managedSiteMediaTagLinks.ownerUserId, scope.ownerUserId),
          eq(managedSiteMediaTagLinks.projectId, scope.projectId),
          inArray(managedSiteMediaTagLinks.assetId, assetIds)
        )
      ),
    database
      .select({
        assetId: managedSiteMediaUploadSessions.assetId,
        objectKey: managedSiteMediaUploadSessions.objectKey,
      })
      .from(managedSiteMediaUploadSessions)
      .where(
        and(
          eq(managedSiteMediaUploadSessions.ownerUserId, scope.ownerUserId),
          eq(managedSiteMediaUploadSessions.projectId, scope.projectId),
          inArray(managedSiteMediaUploadSessions.assetId, assetIds),
          inArray(managedSiteMediaUploadSessions.status, [
            "issued",
            "uploading",
            "uploaded",
            "completing",
          ])
        )
      )
      .orderBy(desc(managedSiteMediaUploadSessions.createdAt)),
  ]);
  const variantsByVersion = new Map<number, any[]>();
  for (const variant of variants) {
    const current = variantsByVersion.get(variant.assetVersionId) || [];
    current.push(variant);
    variantsByVersion.set(variant.assetVersionId, current);
  }
  const tagsByAsset = new Map<string, any[]>();
  for (const tag of tags) {
    const current = tagsByAsset.get(tag.assetId) || [];
    current.push({ id: tag.id, name: tag.name, canonicalKey: tag.canonicalKey });
    tagsByAsset.set(tag.assetId, current);
  }
  const pendingUploadByAsset = new Map<string, string>();
  for (const upload of uploads)
    if (!pendingUploadByAsset.has(upload.assetId))
      pendingUploadByAsset.set(upload.assetId, upload.objectKey);
  return rows.map(({ asset, version, originalObjectKey }) => {
    const rights = asset.rightsMetadata as any;
    return {
      ownerUserId: asset.ownerUserId,
      projectId: asset.projectId,
      assetId: asset.assetId,
      version: asset.currentVersion,
      status: asset.status,
      visibility: asset.visibility,
      filename: asset.originalFilename,
      declaredMime: version.declaredMime,
      sniffedMime: version.sniffedMime || null,
      byteSize: version.byteSize,
      width: version.width || null,
      height: version.height || null,
      sha256: version.sha256 || null,
      originalObjectKey:
        originalObjectKey ||
        (provisionalStatuses.has(asset.status)
          ? pendingUploadByAsset.get(asset.assetId) || ""
          : ""),
      processingFingerprint: version.processingFingerprint || null,
      scannerVerdict: (version.metadata as any)?.scannerVerdict || null,
      variants: (variantsByVersion.get(version.id) || []).map((item) => ({
        key: item.key,
        format: item.format,
        width: item.width,
        height: item.height,
        byteSize: item.byteSize,
        sha256: item.sha256,
        objectKey: item.objectKey,
        transformation: item.transformation,
      })),
      collectionId: asset.collectionId,
      tags: tagsByAsset.get(asset.assetId) || [],
      rightsMetadata: {
        license: rights?.license ?? null,
        source: rights?.source ?? null,
        photographer: rights?.photographer ?? null,
        consentReference: rights?.consentReference ?? null,
        publishAllowed: rights?.publishAllowed === true,
        expiresAt: rights?.expiresAt ?? null,
      },
      createdAt: date(asset.createdAt)!,
      trashedAt: date(asset.trashedAt),
      retentionUntil: date(asset.retentionUntil),
      deletedAt: date(asset.deletedAt),
    } as MediaAssetProjection;
  });
}

export function makeDrizzleMediaVaultRepository(
  database: any
): MediaVaultRepository {
  const repository: MediaVaultRepository = {
    async transaction<T>(
      work: (repository: MediaVaultRepository) => Promise<T>
    ) {
      return database.transaction((transaction: any) =>
        work(makeDrizzleMediaVaultRepository(transaction))
      ) as Promise<T>;
    },
    async getQuota(scope) {
      const periodKey = new Date().toISOString().slice(0, 7);
      let [row] = await database
        .select()
        .from(managedSiteMediaQuotaProjections)
        .where(
          and(
            eq(managedSiteMediaQuotaProjections.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
            eq(managedSiteMediaQuotaProjections.periodKey, periodKey)
          )
        )
        .limit(1);
      if (!row) {
        const [subscription] = await database
          .select()
          .from(managedSiteSubscriptions)
          .where(
            and(
              eq(managedSiteSubscriptions.ownerUserId, scope.ownerUserId),
              eq(managedSiteSubscriptions.projectId, scope.projectId)
            )
          )
          .limit(1);
        if (
          !subscription ||
          !["active", "grace_period"].includes(subscription.status)
        )
          throw createError({
            statusCode: 403,
            statusMessage:
              "An active managed-site plan is required for media storage.",
          });
        const [previous] = await database
          .select()
          .from(managedSiteMediaQuotaProjections)
          .where(
            and(
              eq(
                managedSiteMediaQuotaProjections.ownerUserId,
                scope.ownerUserId
              ),
              eq(managedSiteMediaQuotaProjections.projectId, scope.projectId)
            )
          )
          .orderBy(desc(managedSiteMediaQuotaProjections.periodKey))
          .limit(1);
        const premium = /business|growth|premium|pro/iu.test(
          subscription.planKey
        );
        const quota = {
          ownerUserId: scope.ownerUserId,
          projectId: scope.projectId,
          planKey: subscription.planKey,
          maxOriginalBytes: premium ? 2_000_000_000 : 500_000_000,
          maxAssetCount: premium ? 20_000 : 5_000,
          maxMonthlyUploadBytes: premium ? 2_000_000_000 : 1_000_000_000,
          maxMonthlyProcessingCount: premium ? 20_000 : 5_000,
          originalBytesUsed: previous?.originalBytesUsed || 0,
          assetCountUsed: previous?.assetCountUsed || 0,
          monthlyUploadBytesUsed: 0,
          monthlyProcessingCountUsed: 0,
          periodKey,
          projectionFingerprint: "",
        };
        quota.projectionFingerprint = stableFingerprint(quota);
        await database
          .insert(managedSiteMediaQuotaProjections)
          .values(quota)
          .onDuplicateKeyUpdate({
            set: {
              planKey: subscription.planKey,
              maxOriginalBytes: quota.maxOriginalBytes,
              maxAssetCount: quota.maxAssetCount,
              maxMonthlyUploadBytes: quota.maxMonthlyUploadBytes,
              maxMonthlyProcessingCount: quota.maxMonthlyProcessingCount,
            },
          });
        [row] = await database
          .select()
          .from(managedSiteMediaQuotaProjections)
          .where(
            and(
              eq(
                managedSiteMediaQuotaProjections.ownerUserId,
                scope.ownerUserId
              ),
              eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
              eq(managedSiteMediaQuotaProjections.periodKey, periodKey)
            )
          )
          .limit(1);
      }
      if (!row)
        throw createError({
          statusCode: 503,
          statusMessage: "Media quota projection could not be resolved.",
        });
      return {
        maxOriginalBytes: row.maxOriginalBytes,
        maxAssetCount: row.maxAssetCount,
        maxMonthlyUploadBytes: row.maxMonthlyUploadBytes,
        maxMonthlyProcessingCount: row.maxMonthlyProcessingCount,
        originalBytesUsed: row.originalBytesUsed,
        assetCountUsed: row.assetCountUsed,
        monthlyUploadBytesUsed: row.monthlyUploadBytesUsed,
        monthlyProcessingCountUsed: row.monthlyProcessingCountUsed,
        periodKey: row.periodKey,
      };
    },
    async reserveQuota(scope, input) {
      const quota = await repository.getQuota(scope);
      const [existing] = await database
        .select()
        .from(managedSiteMediaQuotaClaims)
        .where(
          and(
            eq(managedSiteMediaQuotaClaims.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaClaims.projectId, scope.projectId),
            eq(managedSiteMediaQuotaClaims.periodKey, quota.periodKey),
            eq(managedSiteMediaQuotaClaims.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        if (
          existing.claimKind !== "reservation" ||
          existing.requestFingerprint !== input.requestFingerprint ||
          existing.originalBytes !== input.delta.originalBytes ||
          existing.assetCount !== input.delta.assetCount ||
          existing.uploadBytes !== input.delta.uploadBytes ||
          existing.processingCount !== input.delta.processingCount
        )
          throw createError({
            statusCode: 409,
            statusMessage: "Media quota idempotency key collided.",
          });
        return {
          idempotencyKey: existing.idempotencyKey,
          requestFingerprint: existing.requestFingerprint,
          periodKey: existing.periodKey,
          delta: {
            originalBytes: existing.originalBytes,
            assetCount: existing.assetCount,
            uploadBytes: existing.uploadBytes,
            processingCount: existing.processingCount,
          },
          status: existing.status,
          replayed: true,
        };
      }
      const updated = await database
        .update(managedSiteMediaQuotaProjections)
        .set({
          originalBytesUsed: sql`${managedSiteMediaQuotaProjections.originalBytesUsed} + ${input.delta.originalBytes}`,
          assetCountUsed: sql`${managedSiteMediaQuotaProjections.assetCountUsed} + ${input.delta.assetCount}`,
          monthlyUploadBytesUsed: sql`${managedSiteMediaQuotaProjections.monthlyUploadBytesUsed} + ${input.delta.uploadBytes}`,
          monthlyProcessingCountUsed: sql`${managedSiteMediaQuotaProjections.monthlyProcessingCountUsed} + ${input.delta.processingCount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedSiteMediaQuotaProjections.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
            eq(managedSiteMediaQuotaProjections.periodKey, quota.periodKey),
            sql`${managedSiteMediaQuotaProjections.originalBytesUsed} + ${input.delta.originalBytes} <= ${managedSiteMediaQuotaProjections.maxOriginalBytes}`,
            sql`${managedSiteMediaQuotaProjections.assetCountUsed} + ${input.delta.assetCount} <= ${managedSiteMediaQuotaProjections.maxAssetCount}`,
            sql`${managedSiteMediaQuotaProjections.monthlyUploadBytesUsed} + ${input.delta.uploadBytes} <= ${managedSiteMediaQuotaProjections.maxMonthlyUploadBytes}`,
            sql`${managedSiteMediaQuotaProjections.monthlyProcessingCountUsed} + ${input.delta.processingCount} <= ${managedSiteMediaQuotaProjections.maxMonthlyProcessingCount}`
          )
        );
      if (Number((updated as any)?.[0]?.affectedRows || 0) !== 1)
        throw createError({
          statusCode: 413,
          statusMessage: "Media quota would be exceeded.",
        });
      await database
        .insert(managedSiteMediaQuotaClaims)
        .values({
          ownerUserId: scope.ownerUserId,
          projectId: scope.projectId,
          periodKey: quota.periodKey,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          claimKind: "reservation",
          originalBytes: input.delta.originalBytes,
          assetCount: input.delta.assetCount,
          uploadBytes: input.delta.uploadBytes,
          processingCount: input.delta.processingCount,
          status: "reserved",
        });
      return {
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        periodKey: quota.periodKey,
        delta: input.delta,
        status: "reserved",
        replayed: false,
      };
    },
    async settleQuota(scope, input) {
      const current = await repository.getQuota(scope);
      const [claim] = await database
        .select()
        .from(managedSiteMediaQuotaClaims)
        .where(
          and(
            eq(managedSiteMediaQuotaClaims.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaClaims.projectId, scope.projectId),
            eq(managedSiteMediaQuotaClaims.idempotencyKey, input.idempotencyKey)
          )
        )
        .orderBy(desc(managedSiteMediaQuotaClaims.createdAt))
        .limit(1);
      if (
        !claim ||
        claim.claimKind !== "reservation" ||
        claim.requestFingerprint !== input.requestFingerprint
      )
        throw createError({
          statusCode: 409,
          statusMessage: "Media quota reservation was not found or collided.",
        });
      if (claim.status === "released")
        throw createError({
          statusCode: 409,
          statusMessage: "Released media quota cannot be committed.",
        });
      const committed = input.committed;
      if (
        [
          committed.originalBytes,
          committed.assetCount,
          committed.uploadBytes,
          committed.processingCount,
        ].some(value => !Number.isSafeInteger(value) || value < 0) ||
        committed.originalBytes > claim.originalBytes ||
        committed.assetCount > claim.assetCount ||
        committed.uploadBytes > claim.uploadBytes ||
        committed.processingCount > claim.processingCount
      )
        throw createError({
          statusCode: 409,
          statusMessage: "Media quota settlement exceeds its reservation.",
        });
      if (claim.status === "committed") {
        if (
          claim.originalBytes !== committed.originalBytes ||
          claim.assetCount !== committed.assetCount ||
          claim.uploadBytes !== committed.uploadBytes ||
          claim.processingCount !== committed.processingCount
        )
          throw createError({
            statusCode: 409,
            statusMessage: "Committed media quota settlement collided.",
          });
        return {
          idempotencyKey: claim.idempotencyKey,
          requestFingerprint: claim.requestFingerprint,
          periodKey: claim.periodKey,
          delta: committed,
          status: "committed",
          replayed: true,
        };
      }
      const transitioned = await database
        .update(managedSiteMediaQuotaClaims)
        .set({
          status: "committed",
          originalBytes: committed.originalBytes,
          assetCount: committed.assetCount,
          uploadBytes: committed.uploadBytes,
          processingCount: committed.processingCount,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedSiteMediaQuotaClaims.id, claim.id),
            eq(managedSiteMediaQuotaClaims.status, "reserved"),
            eq(managedSiteMediaQuotaClaims.claimKind, "reservation")
          )
        );
      if (Number((transitioned as any)?.[0]?.affectedRows || 0) !== 1)
        throw createError({
          statusCode: 409,
          statusMessage: "Media quota reservation changed concurrently.",
        });
      const originalAdjustment = claim.originalBytes - committed.originalBytes;
      const assetAdjustment = claim.assetCount - committed.assetCount;
      const adjusted = await database
        .update(managedSiteMediaQuotaProjections)
        .set({
          originalBytesUsed: sql`${managedSiteMediaQuotaProjections.originalBytesUsed} - ${originalAdjustment}`,
          assetCountUsed: sql`${managedSiteMediaQuotaProjections.assetCountUsed} - ${assetAdjustment}`,
          monthlyUploadBytesUsed: sql`${managedSiteMediaQuotaProjections.monthlyUploadBytesUsed} - ${claim.uploadBytes - committed.uploadBytes}`,
          monthlyProcessingCountUsed: sql`${managedSiteMediaQuotaProjections.monthlyProcessingCountUsed} - ${claim.processingCount - committed.processingCount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedSiteMediaQuotaProjections.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
            eq(managedSiteMediaQuotaProjections.periodKey, claim.periodKey)
          )
        );
      if (Number((adjusted as any)?.[0]?.affectedRows || 0) !== 1)
        throw createError({
          statusCode: 409,
          statusMessage:
            "Media quota projection is missing for its reservation.",
        });
      if (
        claim.periodKey !== current.periodKey &&
        (originalAdjustment || assetAdjustment)
      ) {
        const carried = await database
          .update(managedSiteMediaQuotaProjections)
          .set({
            originalBytesUsed: sql`${managedSiteMediaQuotaProjections.originalBytesUsed} - ${originalAdjustment}`,
            assetCountUsed: sql`${managedSiteMediaQuotaProjections.assetCountUsed} - ${assetAdjustment}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(
                managedSiteMediaQuotaProjections.ownerUserId,
                scope.ownerUserId
              ),
              eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
              eq(managedSiteMediaQuotaProjections.periodKey, current.periodKey)
            )
          );
        if (Number((carried as any)?.[0]?.affectedRows || 0) !== 1)
          throw createError({
            statusCode: 409,
            statusMessage: "Current media quota carry-forward is missing.",
          });
      }
      return {
        idempotencyKey: claim.idempotencyKey,
        requestFingerprint: claim.requestFingerprint,
        periodKey: claim.periodKey,
        delta: committed,
        status: "committed",
        replayed: false,
      };
    },
    async releaseQuota(scope, input) {
      const current = await repository.getQuota(scope);
      const [claim] = await database
        .select()
        .from(managedSiteMediaQuotaClaims)
        .where(
          and(
            eq(managedSiteMediaQuotaClaims.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaClaims.projectId, scope.projectId),
            eq(managedSiteMediaQuotaClaims.idempotencyKey, input.idempotencyKey)
          )
        )
        .orderBy(desc(managedSiteMediaQuotaClaims.createdAt))
        .limit(1);
      if (
        !claim ||
        claim.claimKind !== "reservation" ||
        claim.requestFingerprint !== input.requestFingerprint
      )
        throw createError({
          statusCode: 409,
          statusMessage: "Media quota reservation was not found or collided.",
        });
      if (claim.status === "committed")
        throw createError({
          statusCode: 409,
          statusMessage: "Committed media quota cannot be released.",
        });
      const delta = {
        originalBytes: claim.originalBytes,
        assetCount: claim.assetCount,
        uploadBytes: claim.uploadBytes,
        processingCount: claim.processingCount,
      };
      if (claim.status === "released")
        return {
          idempotencyKey: claim.idempotencyKey,
          requestFingerprint: claim.requestFingerprint,
          periodKey: claim.periodKey,
          delta,
          status: "released",
          replayed: true,
        };
      const transitioned = await database
        .update(managedSiteMediaQuotaClaims)
        .set({ status: "released", updatedAt: new Date() })
        .where(
          and(
            eq(managedSiteMediaQuotaClaims.id, claim.id),
            eq(managedSiteMediaQuotaClaims.status, "reserved"),
            eq(managedSiteMediaQuotaClaims.claimKind, "reservation")
          )
        );
      if (Number((transitioned as any)?.[0]?.affectedRows || 0) !== 1)
        throw createError({
          statusCode: 409,
          statusMessage: "Media quota reservation changed concurrently.",
        });
      const adjusted = await database
        .update(managedSiteMediaQuotaProjections)
        .set({
          originalBytesUsed: sql`${managedSiteMediaQuotaProjections.originalBytesUsed} - ${claim.originalBytes}`,
          assetCountUsed: sql`${managedSiteMediaQuotaProjections.assetCountUsed} - ${claim.assetCount}`,
          monthlyUploadBytesUsed: sql`${managedSiteMediaQuotaProjections.monthlyUploadBytesUsed} - ${claim.uploadBytes}`,
          monthlyProcessingCountUsed: sql`${managedSiteMediaQuotaProjections.monthlyProcessingCountUsed} - ${claim.processingCount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedSiteMediaQuotaProjections.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
            eq(managedSiteMediaQuotaProjections.periodKey, claim.periodKey)
          )
        );
      if (Number((adjusted as any)?.[0]?.affectedRows || 0) !== 1)
        throw createError({
          statusCode: 409,
          statusMessage:
            "Media quota projection is missing for its reservation.",
        });
      if (
        claim.periodKey !== current.periodKey &&
        (claim.originalBytes || claim.assetCount)
      ) {
        const carried = await database
          .update(managedSiteMediaQuotaProjections)
          .set({
            originalBytesUsed: sql`${managedSiteMediaQuotaProjections.originalBytesUsed} - ${claim.originalBytes}`,
            assetCountUsed: sql`${managedSiteMediaQuotaProjections.assetCountUsed} - ${claim.assetCount}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(
                managedSiteMediaQuotaProjections.ownerUserId,
                scope.ownerUserId
              ),
              eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
              eq(managedSiteMediaQuotaProjections.periodKey, current.periodKey)
            )
          );
        if (Number((carried as any)?.[0]?.affectedRows || 0) !== 1)
          throw createError({
            statusCode: 409,
            statusMessage: "Current media quota carry-forward is missing.",
          });
      }
      return {
        idempotencyKey: claim.idempotencyKey,
        requestFingerprint: claim.requestFingerprint,
        periodKey: claim.periodKey,
        delta,
        status: "released",
        replayed: false,
      };
    },
    async creditQuota(scope, input) {
      const quota = await repository.getQuota(scope);
      const [existing] = await database
        .select()
        .from(managedSiteMediaQuotaClaims)
        .where(
          and(
            eq(managedSiteMediaQuotaClaims.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaClaims.projectId, scope.projectId),
            eq(managedSiteMediaQuotaClaims.periodKey, quota.periodKey),
            eq(managedSiteMediaQuotaClaims.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      const delta = {
        originalBytes: input.delta.originalBytes,
        assetCount: input.delta.assetCount,
        uploadBytes: 0,
        processingCount: 0,
      };
      if (existing) {
        if (
          existing.claimKind !== "credit" ||
          existing.requestFingerprint !== input.requestFingerprint ||
          existing.originalBytes !== delta.originalBytes ||
          existing.assetCount !== delta.assetCount
        )
          throw createError({
            statusCode: 409,
            statusMessage: "Media quota credit idempotency key collided.",
          });
        return {
          idempotencyKey: existing.idempotencyKey,
          requestFingerprint: existing.requestFingerprint,
          periodKey: existing.periodKey,
          delta,
          status: existing.status,
          replayed: true,
        };
      }
      const updated = await database
        .update(managedSiteMediaQuotaProjections)
        .set({
          originalBytesUsed: sql`${managedSiteMediaQuotaProjections.originalBytesUsed} - ${delta.originalBytes}`,
          assetCountUsed: sql`${managedSiteMediaQuotaProjections.assetCountUsed} - ${delta.assetCount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedSiteMediaQuotaProjections.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
            eq(managedSiteMediaQuotaProjections.periodKey, quota.periodKey),
            sql`${managedSiteMediaQuotaProjections.originalBytesUsed} >= ${delta.originalBytes}`,
            sql`${managedSiteMediaQuotaProjections.assetCountUsed} >= ${delta.assetCount}`
          )
        );
      if (Number((updated as any)?.[0]?.affectedRows || 0) !== 1)
        throw createError({
          statusCode: 409,
          statusMessage: "Media quota credit exceeds committed usage.",
        });
      await database
        .insert(managedSiteMediaQuotaClaims)
        .values({
          ownerUserId: scope.ownerUserId,
          projectId: scope.projectId,
          periodKey: quota.periodKey,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          claimKind: "credit",
          originalBytes: delta.originalBytes,
          assetCount: delta.assetCount,
          uploadBytes: 0,
          processingCount: 0,
          status: "committed",
        });
      return {
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        periodKey: quota.periodKey,
        delta,
        status: "committed",
        replayed: false,
      };
    },
    async saveQuota(scope, quota) {
      await database
        .update(managedSiteMediaQuotaProjections)
        .set({
          originalBytesUsed: quota.originalBytesUsed,
          assetCountUsed: quota.assetCountUsed,
          monthlyUploadBytesUsed: quota.monthlyUploadBytesUsed,
          monthlyProcessingCountUsed: quota.monthlyProcessingCountUsed,
          projectionFingerprint: (
            await import("../../seo-geo-core/repository")
          ).stableFingerprint(quota),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedSiteMediaQuotaProjections.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaQuotaProjections.projectId, scope.projectId),
            eq(managedSiteMediaQuotaProjections.periodKey, quota.periodKey)
          )
        );
    },
    async findUploadById(scope, uploadId) {
      const [row] = await database
        .select()
        .from(managedSiteMediaUploadSessions)
        .where(
          and(
            eq(managedSiteMediaUploadSessions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaUploadSessions.projectId, scope.projectId),
            eq(managedSiteMediaUploadSessions.uploadId, uploadId)
          )
        )
        .limit(1);
      return row
        ? {
            ownerUserId: row.ownerUserId,
            projectId: row.projectId,
            uploadId: row.uploadId,
            assetId: row.assetId,
            objectKey: row.objectKey,
            filename: row.originalFilename,
            declaredMime: row.declaredMime,
            declaredBytes: row.declaredBytes,
            visibility: row.visibility,
            status:
              row.status === "uploading" || row.status === "uploaded"
                ? "issued"
                : (row.status as MediaUploadSession["status"]),
            idempotencyKey: row.idempotencyKey,
            requestFingerprint: row.requestFingerprint,
            expiresAt: date(row.expiresAt)!,
            completionFingerprint: row.completionFingerprint,
            quotaOriginalBytesCommitted: row.quotaOriginalBytesCommitted,
            quotaAssetCountCommitted: row.quotaAssetCountCommitted,
          }
        : null;
    },
    async findUploadByIdempotency(scope, idempotencyKey) {
      const [row] = await database
        .select({ uploadId: managedSiteMediaUploadSessions.uploadId })
        .from(managedSiteMediaUploadSessions)
        .where(
          and(
            eq(managedSiteMediaUploadSessions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaUploadSessions.projectId, scope.projectId),
            eq(managedSiteMediaUploadSessions.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      return row ? repository.findUploadById(scope, row.uploadId) : null;
    },
    async insertUpload(upload) {
      const cid = await connectionId(database, upload);
      await database
        .insert(managedSiteMediaUploadSessions)
        .values({
          uploadId: upload.uploadId,
          ownerUserId: upload.ownerUserId,
          projectId: upload.projectId,
          assetId: upload.assetId,
          connectionId: cid,
          objectKey: upload.objectKey,
          originalFilename: upload.filename,
          visibility: upload.visibility,
          declaredMime: upload.declaredMime,
          declaredBytes: upload.declaredBytes,
          idempotencyKey: upload.idempotencyKey,
          requestFingerprint: upload.requestFingerprint,
          status: upload.status,
          expiresAt: new Date(upload.expiresAt),
        } as any);
    },
    async updateUpload(scope, uploadId, patch) {
      await database
        .update(managedSiteMediaUploadSessions)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.completionFingerprint !== undefined
            ? { completionFingerprint: patch.completionFingerprint }
            : {}),
          ...(patch.quotaOriginalBytesCommitted !== undefined
            ? { quotaOriginalBytesCommitted: patch.quotaOriginalBytesCommitted }
            : {}),
          ...(patch.quotaAssetCountCommitted !== undefined
            ? { quotaAssetCountCommitted: patch.quotaAssetCountCommitted }
            : {}),
          ...(patch.status === "completed" ? { completedAt: new Date() } : {}),
        } as any)
        .where(
          and(
            eq(managedSiteMediaUploadSessions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaUploadSessions.projectId, scope.projectId),
            eq(managedSiteMediaUploadSessions.uploadId, uploadId)
          )
        );
      return repository.findUploadById(scope, uploadId);
    },
    async claimUploadStatus(scope, uploadId, from, to) {
      if (!from.length) return false;
      const result = await database
        .update(managedSiteMediaUploadSessions)
        .set({ status: to })
        .where(
          and(
            eq(managedSiteMediaUploadSessions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaUploadSessions.projectId, scope.projectId),
            eq(managedSiteMediaUploadSessions.uploadId, uploadId),
            inArray(managedSiteMediaUploadSessions.status, from)
          )
        );
      return Number((result as any)?.[0]?.affectedRows || 0) === 1;
    },
    async findAsset(scope, assetId) {
      const rows = await database
        .select({
          asset: managedSiteMediaAssets,
          version: managedSiteMediaAssetVersions,
          originalObjectKey: managedSiteMediaObjects.objectKey,
        })
        .from(managedSiteMediaAssets)
        .innerJoin(
          managedSiteMediaAssetVersions,
          and(
            eq(managedSiteMediaAssets.currentVersionId, managedSiteMediaAssetVersions.id),
            eq(managedSiteMediaAssetVersions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssetVersions.projectId, scope.projectId)
          )
        )
        .leftJoin(
          managedSiteMediaObjects,
          and(
            eq(managedSiteMediaObjects.assetVersionId, managedSiteMediaAssetVersions.id),
            eq(managedSiteMediaObjects.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaObjects.projectId, scope.projectId),
            eq(managedSiteMediaObjects.objectKind, "original"),
            isNull(managedSiteMediaObjects.deletedAt)
          )
        )
        .where(
          and(
            eq(managedSiteMediaAssets.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssets.projectId, scope.projectId),
            eq(managedSiteMediaAssets.assetId, assetId)
          )
        )
        .limit(1);
      return (await projectAssetRows(database, scope, rows))[0] || null;
    },
    async findReadyAssetByHash(scope, sha256) {
      const [version] = await database
        .select({ assetId: managedSiteMediaAssetVersions.assetId })
        .from(managedSiteMediaAssetVersions)
        .innerJoin(
          managedSiteMediaAssets,
          and(
            eq(
              managedSiteMediaAssets.assetId,
              managedSiteMediaAssetVersions.assetId
            ),
            eq(managedSiteMediaAssets.status, "ready")
          )
        )
        .where(
          and(
            eq(managedSiteMediaAssetVersions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssetVersions.projectId, scope.projectId),
            eq(managedSiteMediaAssetVersions.sha256, sha256)
          )
        )
        .limit(1);
      return version ? repository.findAsset(scope, version.assetId) : null;
    },
    async listAssets(scope, options = {}) {
      const limit = Number.isSafeInteger(options.limit)
        ? Math.max(1, Math.min(100, options.limit!))
        : 100;
      const before =
        options.beforeCreatedAt && options.beforeAssetId
          ? new Date(options.beforeCreatedAt)
          : null;
      if (before && !Number.isFinite(before.getTime()))
        throw createError({
          statusCode: 422,
          statusMessage: "Media pagination cursor is invalid.",
        });
      const rows = await database
        .select({
          asset: managedSiteMediaAssets,
          version: managedSiteMediaAssetVersions,
          originalObjectKey: managedSiteMediaObjects.objectKey,
        })
        .from(managedSiteMediaAssets)
        .innerJoin(
          managedSiteMediaAssetVersions,
          and(
            eq(managedSiteMediaAssets.currentVersionId, managedSiteMediaAssetVersions.id),
            eq(managedSiteMediaAssetVersions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssetVersions.projectId, scope.projectId)
          )
        )
        .leftJoin(
          managedSiteMediaObjects,
          and(
            eq(managedSiteMediaObjects.assetVersionId, managedSiteMediaAssetVersions.id),
            eq(managedSiteMediaObjects.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaObjects.projectId, scope.projectId),
            eq(managedSiteMediaObjects.objectKind, "original"),
            isNull(managedSiteMediaObjects.deletedAt)
          )
        )
        .where(
          and(
            eq(managedSiteMediaAssets.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssets.projectId, scope.projectId),
            isNull(managedSiteMediaAssets.deletedAt),
            ne(managedSiteMediaAssets.status, "deleted"),
            ...(before
              ? [
                  or(
                    lt(managedSiteMediaAssets.createdAt, before),
                    and(
                      eq(managedSiteMediaAssets.createdAt, before),
                      lt(managedSiteMediaAssets.assetId, options.beforeAssetId!)
                    )
                  )!,
                ]
              : [])
          )
        )
        .orderBy(desc(managedSiteMediaAssets.createdAt), desc(managedSiteMediaAssets.assetId))
        .limit(limit);
      return projectAssetRows(database, scope, rows);
    },
    async insertAsset(asset) {
      const result = await database
        .insert(managedSiteMediaAssets)
        .values({
          assetId: asset.assetId,
          ownerUserId: asset.ownerUserId,
          projectId: asset.projectId,
          visibility: asset.visibility,
          originalFilename: asset.filename,
          mediaType: "image",
          status: asset.status,
          currentVersion: asset.version,
          currentVersionId: null,
          collectionId: asset.collectionId,
          createdByUserId: null,
          createdByAuthority: "customer_session",
          rightsMetadata: asset.rightsMetadata,
          createdAt: new Date(asset.createdAt),
        } as any);
      const mediaId = insertId(result);
      const versionResult = await database
        .insert(managedSiteMediaAssetVersions)
        .values({
          ownerUserId: asset.ownerUserId,
          projectId: asset.projectId,
          assetId: asset.assetId,
          version: asset.version,
          declaredMime: asset.declaredMime,
          sniffedMime: asset.sniffedMime,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
          durationMs: null,
          sha256: asset.sha256,
          processingFingerprint: asset.processingFingerprint,
          parentVersionId: null,
          metadata: { scannerVerdict: asset.scannerVerdict },
        } as any);
      await database
        .update(managedSiteMediaAssets)
        .set({ currentVersionId: insertId(versionResult) })
        .where(eq(managedSiteMediaAssets.id, mediaId));
    },
    async updateAsset(scope, assetId, patch) {
      const current = await repository.findAsset(scope, assetId);
      if (!current) return null;
      const [version] = await database
        .select({ id: managedSiteMediaAssetVersions.id })
        .from(managedSiteMediaAssetVersions)
        .where(
          and(
            eq(managedSiteMediaAssetVersions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssetVersions.projectId, scope.projectId),
            eq(managedSiteMediaAssetVersions.assetId, assetId),
            eq(managedSiteMediaAssetVersions.version, current.version)
          )
        )
        .limit(1);
      if (!version) return null;
      await database
        .update(managedSiteMediaAssets)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.visibility ? { visibility: patch.visibility } : {}),
          ...(patch.filename ? { originalFilename: patch.filename } : {}),
          ...(patch.collectionId !== undefined
            ? { collectionId: patch.collectionId }
            : {}),
          ...(patch.rightsMetadata !== undefined
            ? { rightsMetadata: patch.rightsMetadata }
            : {}),
          ...(patch.trashedAt !== undefined
            ? { trashedAt: patch.trashedAt ? new Date(patch.trashedAt) : null }
            : {}),
          ...(patch.retentionUntil !== undefined
            ? {
                retentionUntil: patch.retentionUntil
                  ? new Date(patch.retentionUntil)
                  : null,
              }
            : {}),
          ...(patch.deletedAt !== undefined
            ? { deletedAt: patch.deletedAt ? new Date(patch.deletedAt) : null }
            : {}),
        } as any)
        .where(
          and(
            eq(managedSiteMediaAssets.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssets.projectId, scope.projectId),
            eq(managedSiteMediaAssets.assetId, assetId)
          )
        );
      await database
        .update(managedSiteMediaAssetVersions)
        .set({
          ...(patch.sniffedMime !== undefined
            ? { sniffedMime: patch.sniffedMime }
            : {}),
          ...(patch.byteSize !== undefined ? { byteSize: patch.byteSize } : {}),
          ...(patch.width !== undefined ? { width: patch.width } : {}),
          ...(patch.height !== undefined ? { height: patch.height } : {}),
          ...(patch.sha256 !== undefined ? { sha256: patch.sha256 } : {}),
          ...(patch.processingFingerprint !== undefined
            ? { processingFingerprint: patch.processingFingerprint }
            : {}),
          ...(patch.scannerVerdict !== undefined
            ? { metadata: { scannerVerdict: patch.scannerVerdict } }
            : {}),
        } as any)
        .where(
          and(
            eq(managedSiteMediaAssetVersions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssetVersions.projectId, scope.projectId),
            eq(managedSiteMediaAssetVersions.assetId, assetId),
            eq(managedSiteMediaAssetVersions.version, current.version)
          )
        );
      const cid = await connectionId(database, scope);
      if (patch.sha256 && current.originalObjectKey) {
        await database
          .insert(managedSiteMediaObjects)
          .values({
            ownerUserId: scope.ownerUserId,
            projectId: scope.projectId,
            assetVersionId: version.id,
            connectionId: cid,
            objectKey: current.originalObjectKey,
            objectVersionReference: null,
            objectKind: "original",
            byteSize: patch.byteSize ?? current.byteSize,
            sha256: patch.sha256,
          } as any)
          .onDuplicateKeyUpdate({
            set: {
              // Object identity is immutable. A duplicate key may only confirm
              // the exact version/hash binding; the following no-op preserves it.
              objectKey: current.originalObjectKey,
            },
          });
        const [bound] = await database
          .select({
            assetVersionId: managedSiteMediaObjects.assetVersionId,
            sha256: managedSiteMediaObjects.sha256,
          })
          .from(managedSiteMediaObjects)
          .where(
            and(
              eq(managedSiteMediaObjects.connectionId, cid),
              eq(managedSiteMediaObjects.objectKey, current.originalObjectKey)
            )
          )
          .limit(1);
        if (
          !bound ||
          bound.assetVersionId !== version.id ||
          bound.sha256 !== patch.sha256
        )
          throw createError({
            statusCode: 409,
            statusMessage:
              "Media original object is already bound to another immutable version.",
          });
      }
      if (patch.variants?.length) {
        for (const variant of patch.variants) {
          const objectId = insertId(
            await database
              .insert(managedSiteMediaObjects)
              .values({
                ownerUserId: scope.ownerUserId,
                projectId: scope.projectId,
                assetVersionId: version.id,
                connectionId: cid,
                objectKey: variant.objectKey,
                objectVersionReference: null,
                objectKind: "variant",
                byteSize: variant.byteSize,
                sha256: variant.sha256,
              } as any)
          );
          await database
            .insert(managedSiteMediaVariants)
            .values({
              ownerUserId: scope.ownerUserId,
              projectId: scope.projectId,
              assetVersionId: version.id,
              mediaObjectId: objectId,
              variantKey: variant.key,
              format: variant.format,
              width: variant.width,
              height: variant.height,
              byteSize: variant.byteSize,
              sha256: variant.sha256,
              transformation: variant.transformation,
            } as any);
        }
      }
      return repository.findAsset(scope, assetId);
    },
    async appendReplacementVersion(scope, replacement) {
      const current = await repository.findAsset(scope, replacement.assetId);
      if (!current || replacement.version !== current.version + 1) return null;
      const [parent] = await database
        .select({ id: managedSiteMediaAssetVersions.id })
        .from(managedSiteMediaAssetVersions)
        .where(
          and(
            eq(managedSiteMediaAssetVersions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssetVersions.projectId, scope.projectId),
            eq(managedSiteMediaAssetVersions.assetId, replacement.assetId),
            eq(managedSiteMediaAssetVersions.version, current.version)
          )
        )
        .limit(1);
      if (!parent) return null;
      const versionId = insertId(
        await database
          .insert(managedSiteMediaAssetVersions)
          .values({
            ownerUserId: scope.ownerUserId,
            projectId: scope.projectId,
            assetId: replacement.assetId,
            version: replacement.version,
            declaredMime: replacement.declaredMime,
            sniffedMime: replacement.sniffedMime,
            byteSize: replacement.byteSize,
            width: replacement.width,
            height: replacement.height,
            durationMs: null,
            sha256: replacement.sha256,
            processingFingerprint: replacement.processingFingerprint,
            parentVersionId: parent.id,
            metadata: { scannerVerdict: replacement.scannerVerdict },
          } as any)
      );
      const cid = await connectionId(database, scope);
      await database.insert(managedSiteMediaObjects).values({
        ownerUserId: scope.ownerUserId,
        projectId: scope.projectId,
        assetVersionId: versionId,
        connectionId: cid,
        objectKey: replacement.originalObjectKey,
        objectVersionReference: null,
        objectKind: "original",
        byteSize: replacement.byteSize,
        sha256: replacement.sha256!,
      } as any);
      for (const variant of replacement.variants) {
        const objectId = insertId(
          await database
            .insert(managedSiteMediaObjects)
            .values({
              ownerUserId: scope.ownerUserId,
              projectId: scope.projectId,
              assetVersionId: versionId,
              connectionId: cid,
              objectKey: variant.objectKey,
              objectVersionReference: null,
              objectKind: "variant",
              byteSize: variant.byteSize,
              sha256: variant.sha256,
            } as any)
        );
        await database
          .insert(managedSiteMediaVariants)
          .values({
            ownerUserId: scope.ownerUserId,
            projectId: scope.projectId,
            assetVersionId: versionId,
            mediaObjectId: objectId,
            variantKey: variant.key,
            format: variant.format,
            width: variant.width,
            height: variant.height,
            byteSize: variant.byteSize,
            sha256: variant.sha256,
            transformation: variant.transformation,
          } as any);
      }
      const updated = await database
        .update(managedSiteMediaAssets)
        .set({
          currentVersion: replacement.version,
          currentVersionId: versionId,
          status: "ready",
          visibility: replacement.visibility,
          originalFilename: replacement.filename,
          rightsMetadata: replacement.rightsMetadata,
        })
        .where(
          and(
            eq(managedSiteMediaAssets.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssets.projectId, scope.projectId),
            eq(managedSiteMediaAssets.assetId, replacement.assetId),
            eq(managedSiteMediaAssets.currentVersion, current.version)
          )
        );
      return Number((updated as any)?.[0]?.affectedRows || 0) === 1
        ? repository.findAsset(scope, replacement.assetId)
        : null;
    },
    async claimAssetStatus(scope, assetId, from, to) {
      if (!from.length) return false;
      const result = await database
        .update(managedSiteMediaAssets)
        .set({ status: to })
        .where(
          and(
            eq(managedSiteMediaAssets.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssets.projectId, scope.projectId),
            eq(managedSiteMediaAssets.assetId, assetId),
            inArray(managedSiteMediaAssets.status, from)
          )
        );
      return Number((result as any)?.[0]?.affectedRows || 0) === 1;
    },
    async listObjectKeys(scope, assetId) {
      const uploads = await database
        .select({ objectKey: managedSiteMediaUploadSessions.objectKey })
        .from(managedSiteMediaUploadSessions)
        .where(
          and(
            eq(managedSiteMediaUploadSessions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaUploadSessions.projectId, scope.projectId),
            eq(managedSiteMediaUploadSessions.assetId, assetId)
          )
        );
      const objects = await database
        .select({ objectKey: managedSiteMediaObjects.objectKey })
        .from(managedSiteMediaObjects)
        .innerJoin(
          managedSiteMediaAssetVersions,
          eq(
            managedSiteMediaObjects.assetVersionId,
            managedSiteMediaAssetVersions.id
          )
        )
        .where(
          and(
            eq(managedSiteMediaObjects.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaObjects.projectId, scope.projectId),
            eq(managedSiteMediaAssetVersions.assetId, assetId)
          )
        );
      return [
        ...new Set(
          [...uploads, ...objects].map(
            (item: { objectKey: string }) => item.objectKey
          )
        ),
      ];
    },
    async getOriginalBytesForAsset(scope, assetId) {
      const [row] = await database
        .select({
          bytes: sql<number>`coalesce(sum(${managedSiteMediaUploadSessions.quotaOriginalBytesCommitted}), 0)`,
        })
        .from(managedSiteMediaUploadSessions)
        .where(
          and(
            eq(managedSiteMediaUploadSessions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaUploadSessions.projectId, scope.projectId),
            eq(managedSiteMediaUploadSessions.assetId, assetId),
            eq(managedSiteMediaUploadSessions.status, "completed")
          )
        );
      return Number(row?.bytes || 0);
    },
    async recordProcessingRun(scope, input) {
      const [version] = await database
        .select({ id: managedSiteMediaAssetVersions.id })
        .from(managedSiteMediaAssetVersions)
        .where(
          and(
            eq(managedSiteMediaAssetVersions.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaAssetVersions.projectId, scope.projectId),
            eq(managedSiteMediaAssetVersions.assetId, input.assetId)
          )
        )
        .orderBy(desc(managedSiteMediaAssetVersions.version))
        .limit(1);
      if (!version)
        throw createError({
          statusCode: 409,
          statusMessage: "Media processing run has no asset version.",
        });
      await database
        .insert(managedSiteMediaProcessingRuns)
        .values({
          ownerUserId: scope.ownerUserId,
          projectId: scope.projectId,
          assetVersionId: version.id,
          status: input.status,
          attemptCount: 1,
          scannerVerdict: input.scannerVerdict,
          processingFingerprint: input.processingFingerprint,
          leaseUntil: null,
          nextAttemptAt:
            input.status === "failed" ? new Date(Date.now() + 60_000) : null,
          errorCode: input.errorCode,
        })
        .onDuplicateKeyUpdate({
          set: {
            status: input.status,
            scannerVerdict: input.scannerVerdict,
            errorCode: input.errorCode,
            attemptCount: sql`${managedSiteMediaProcessingRuns.attemptCount} + 1`,
            updatedAt: new Date(),
          },
        });
    },
    async appendEvent(scope, event) {
      const [existing] = await database
        .select()
        .from(managedSiteMediaEvents)
        .where(
          eq(
            managedSiteMediaEvents.receiptFingerprint,
            event.receiptFingerprint
          )
        )
        .limit(1);
      if (existing)
        return {
          eventType: existing.eventType,
          assetId: existing.assetId,
          uploadId: existing.uploadId,
          receiptFingerprint: existing.receiptFingerprint,
          metadata: existing.metadata as any,
          occurredAt: date(existing.occurredAt)!,
        };
      await database
        .insert(managedSiteMediaEvents)
        .values({
          ownerUserId: scope.ownerUserId,
          projectId: scope.projectId,
          assetId: event.assetId,
          uploadId: event.uploadId,
          eventType: event.eventType,
          actorAuthority: "server_reconstructed",
          beforeFingerprint: null,
          afterFingerprint: null,
          metadata: event.metadata,
          receiptFingerprint: event.receiptFingerprint,
          occurredAt: new Date(event.occurredAt),
        } as any);
      return event;
    },
    async listEvents(scope, assetId) {
      const rows = await database
        .select()
        .from(managedSiteMediaEvents)
        .where(
          and(
            eq(managedSiteMediaEvents.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaEvents.projectId, scope.projectId),
            ...(assetId ? [eq(managedSiteMediaEvents.assetId, assetId)] : [])
          )
        )
        .orderBy(desc(managedSiteMediaEvents.occurredAt))
        .limit(500);
      return rows.map((row: any) => ({
        eventType: row.eventType,
        assetId: row.assetId,
        uploadId: row.uploadId,
        receiptFingerprint: row.receiptFingerprint,
        metadata: row.metadata as any,
        occurredAt: date(row.occurredAt)!,
      }));
    },
    async findEventByIdempotency(scope, input) {
      const [row] = await database
        .select()
        .from(managedSiteMediaEvents)
        .where(
          and(
            eq(managedSiteMediaEvents.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaEvents.projectId, scope.projectId),
            eq(managedSiteMediaEvents.assetId, input.assetId),
            eq(managedSiteMediaEvents.eventType, input.eventType),
            sql`json_unquote(json_extract(${managedSiteMediaEvents.metadata}, '$.idempotencyKey')) = ${input.idempotencyKey}`
          )
        )
        .limit(1);
      return row
        ? {
            eventType: row.eventType,
            assetId: row.assetId,
            uploadId: row.uploadId,
            receiptFingerprint: row.receiptFingerprint,
            metadata: row.metadata as any,
            occurredAt: date(row.occurredAt)!,
          }
        : null;
    },
    async enqueueObjectCleanup(scope, input) {
      if (
        !input.objectKeys.length ||
        input.objectKeys.length > 12 ||
        input.objectKeys.some(key => typeof key !== "string" || key.length > 512)
      )
        throw createError({
          statusCode: 422,
          statusMessage: "Media cleanup object list is invalid.",
        });
      const jobId = `edj_${stableFingerprint({
        kind: "media_object_cleanup",
        sourceReference: input.sourceReference,
        stateFingerprint: input.stateFingerprint,
      }).slice(0, 48)}`;
      await database
        .insert(managedSiteEditorJobs)
        .values({
          jobId,
          ownerUserId: scope.ownerUserId,
          projectId: scope.projectId,
          kind: "media_object_cleanup",
          sourceReference: input.sourceReference.slice(0, 160),
          stateFingerprint: input.stateFingerprint,
          payload: {
            objectKeys: [...new Set(input.objectKeys)],
            finalizeDeletion: input.finalizeDeletion || null,
          },
          status: "queued",
          availableAt: new Date(),
        } as any)
        .onDuplicateKeyUpdate({
          set: {
            stateFingerprint: input.stateFingerprint,
            payload: {
              objectKeys: [...new Set(input.objectKeys)],
              finalizeDeletion: input.finalizeDeletion || null,
            },
          },
        });
    },
    async countActiveUsages(scope, assetId) {
      const [row] = await database
        .select({ count: sql<number>`count(*)` })
        .from(managedSiteMediaUsageBindings)
        .where(
          and(
            eq(managedSiteMediaUsageBindings.ownerUserId, scope.ownerUserId),
            eq(managedSiteMediaUsageBindings.projectId, scope.projectId),
            eq(managedSiteMediaUsageBindings.assetId, assetId),
            isNull(managedSiteMediaUsageBindings.releasedAt)
          )
        );
      return Number(row?.count || 0);
    },
    async setActiveUsageCount() {
      throw createError({
        statusCode: 501,
        statusMessage:
          "Usage binding counts are derived from durable page bindings.",
      });
    },
  };
  return repository;
}
export function getDrizzleMediaVaultRepository(
  database?: any
): MediaVaultRepository {
  return makeDrizzleMediaVaultRepository(database || dbOrThrow());
}

export async function getMediaStorageConnection(scope: MediaTenantScope) {
  const database = dbOrThrow();
  const [row] = await database
    .select()
    .from(managedSiteStorageConnections)
    .where(
      and(
        eq(managedSiteStorageConnections.ownerUserId, scope.ownerUserId),
        eq(managedSiteStorageConnections.projectId, scope.projectId)
      )
    )
    .limit(1);
  if (
    !row ||
    !["verified", "mock"].includes(row.status) ||
    !row.healthReceiptFingerprint
  )
    throw createError({
      statusCode: 503,
      statusMessage: "Media storage connection has no verified health receipt.",
    });
  return row;
}
