import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import { createError } from "h3";
import { getDatabase } from "../../database";
import {
  managedSiteMediaUsageBindings,
  managedSitePageOperations,
  managedSitePagePublicationReceipts,
  managedSitePagePublicationWorks,
  managedSitePages,
  managedSitePageVersions,
} from "../../database/schema";
import {
  canonicalFingerprint,
  canonicalJson,
  parsePageDocument,
} from "./canonical";
import type {
  AppliedPageOperation,
  PageDocument,
  PageEditorRepository,
  PagePublicationReceipt,
} from "./types";
import { serializeManagedPageTransport } from "./transport";

function dbOrThrow() {
  const database = getDatabase();
  if (!database)
    throw createError({
      statusCode: 503,
      statusMessage: "Page editor database is unavailable.",
    });
  return database;
}
function rowsAffected(value: unknown): number {
  return Number((value as any)?.[0]?.affectedRows || 0);
}
function receipt(
  row: typeof managedSitePagePublicationReceipts.$inferSelect
): PagePublicationReceipt {
  return {
    pageId: row.pageId,
    pageVersion: row.pageVersion,
    status:
      row.status === "publishing" || row.status === "rollback_pending"
        ? "intent_created"
        : row.status,
    artifactFingerprint: row.artifactFingerprint,
    mediaSetFingerprint: row.mediaSetFingerprint,
    releaseReference: row.releaseId ? `release:${row.releaseId}` : null,
    publicationTargetReference: row.publicationTargetId
      ? `target:${row.publicationTargetId}`
      : null,
    receiptFingerprint: row.receiptFingerprint,
    createdAt: row.createdAt.toISOString(),
  };
}
export function makeDrizzlePageEditorRepository(
  database: any
): PageEditorRepository {
  const repository: PageEditorRepository = {
    async transaction<T>(
      work: (repository: PageEditorRepository) => Promise<T>
    ) {
      return database.transaction((transaction: any) =>
        work(makeDrizzlePageEditorRepository(transaction))
      ) as Promise<T>;
    },
    async listPages(ownerUserId, projectId, options = {}) {
      const limit = Number.isSafeInteger(options.limit)
        ? Math.max(1, Math.min(100, options.limit!))
        : 100;
      const rows = await database
        .select({ document: managedSitePageVersions.document })
        .from(managedSitePages)
        .innerJoin(
          managedSitePageVersions,
          and(
            eq(managedSitePageVersions.ownerUserId, ownerUserId),
            eq(managedSitePageVersions.projectId, projectId),
            eq(managedSitePageVersions.pageId, managedSitePages.pageId),
            eq(
              managedSitePageVersions.version,
              managedSitePages.currentDraftVersion
            )
          )
        )
        .where(
          and(
            eq(managedSitePages.ownerUserId, ownerUserId),
            eq(managedSitePages.projectId, projectId),
            ...(options.afterRoute && options.afterPageId
              ? [
                  or(
                    gt(managedSitePages.route, options.afterRoute),
                    and(
                      eq(managedSitePages.route, options.afterRoute),
                      gt(managedSitePages.pageId, options.afterPageId)
                    )
                  )!,
                ]
              : [])
          )
        )
        .orderBy(managedSitePages.route, managedSitePages.pageId)
        .limit(limit);
      return rows.map((row: { document: unknown }) =>
        parsePageDocument(row.document)
      );
    },
    async findCurrent(ownerUserId, projectId, pageId) {
      const [page] = await database
        .select({ version: managedSitePages.currentDraftVersion })
        .from(managedSitePages)
        .where(
          and(
            eq(managedSitePages.ownerUserId, ownerUserId),
            eq(managedSitePages.projectId, projectId),
            eq(managedSitePages.pageId, pageId)
          )
        )
        .limit(1);
      return page
        ? repository.findVersion(ownerUserId, projectId, pageId, page.version)
        : null;
    },
    async findVersion(ownerUserId, projectId, pageId, version) {
      const [row] = await database
        .select({ document: managedSitePageVersions.document })
        .from(managedSitePageVersions)
        .where(
          and(
            eq(managedSitePageVersions.ownerUserId, ownerUserId),
            eq(managedSitePageVersions.projectId, projectId),
            eq(managedSitePageVersions.pageId, pageId),
            eq(managedSitePageVersions.version, version)
          )
        )
        .limit(1);
      return row ? parsePageDocument(row.document) : null;
    },
    async listVersions(ownerUserId, projectId, pageId) {
      const rows = await database
        .select({ document: managedSitePageVersions.document })
        .from(managedSitePageVersions)
        .where(
          and(
            eq(managedSitePageVersions.ownerUserId, ownerUserId),
            eq(managedSitePageVersions.projectId, projectId),
            eq(managedSitePageVersions.pageId, pageId)
          )
        )
        .orderBy(desc(managedSitePageVersions.version))
        .limit(200);
      return rows.map((row: { document: unknown }) =>
        parsePageDocument(row.document)
      );
    },
    async insertInitial(ownerUserId, projectId, page) {
      const parsed = parsePageDocument(page);
      await database.transaction(async (transaction: any) => {
        await transaction
          .insert(managedSitePages)
          .values({
            pageId: parsed.pageId,
            ownerUserId,
            projectId,
            locale: parsed.locale,
            route: parsed.route,
            contentType: parsed.contentType,
            currentDraftVersion: 1,
            publishedVersion: 0,
            status: "draft",
          });
        await transaction
          .insert(managedSitePageVersions)
          .values({
            ownerUserId,
            projectId,
            pageId: parsed.pageId,
            version: 1,
            parentVersion: null,
            document: parsed,
            documentFingerprint: parsed.fingerprint,
            lifecycleStatus: "draft",
            actorAuthority: parsed.actorAuthority,
            createdAt: new Date(parsed.createdAt),
          });
        if (parsed.mediaBindings.length)
          await transaction.insert(managedSiteMediaUsageBindings).values(
            parsed.mediaBindings.map(binding => {
              const block = parsed.sections.find(section =>
                section.mediaBindingIds.includes(binding.bindingId)
              );
              const bindingFingerprint = canonicalFingerprint({
                version: "managed-site-media-usage-v1",
                ownerUserId,
                projectId,
                pageId: parsed.pageId,
                pageVersion: parsed.version,
                blockId: block?.blockId || "seo",
                role: binding.role,
                assetId: binding.assetId,
                assetVersion: binding.assetVersion,
                assetSha256: binding.assetSha256,
              });
              return {
                ownerUserId,
                projectId,
                assetId: binding.assetId,
                assetVersion: binding.assetVersion,
                assetSha256: binding.assetSha256,
                pageId: parsed.pageId,
                pageVersion: parsed.version,
                blockId: block?.blockId || "seo",
                role: binding.role,
                bindingFingerprint,
                releasedAt: null,
              };
            })
          );
      });
    },
    async compareAndAppend(
      ownerUserId,
      projectId,
      expectedVersion,
      page,
      operation
    ) {
      const updated = await database
        .update(managedSitePages)
        .set({
          currentDraftVersion: page.version,
          status: "draft",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedSitePages.ownerUserId, ownerUserId),
            eq(managedSitePages.projectId, projectId),
            eq(managedSitePages.pageId, page.pageId),
            eq(managedSitePages.currentDraftVersion, expectedVersion)
          )
        );
      if (rowsAffected(updated) !== 1) return false;
      await database
        .insert(managedSitePageVersions)
        .values({
          ownerUserId,
          projectId,
          pageId: page.pageId,
          version: page.version,
          parentVersion: page.parentVersion,
          document: page,
          documentFingerprint: page.fingerprint,
          lifecycleStatus: "draft",
          actorAuthority: page.actorAuthority,
          createdAt: new Date(page.createdAt),
        });
      await database
        .insert(managedSitePageOperations)
        .values({
          ownerUserId,
          projectId,
          pageId: page.pageId,
          fromVersion: operation.fromVersion,
          toVersion: operation.toVersion,
          commandType: operation.command.type,
          command: operation.command,
          idempotencyKey: operation.command.idempotencyKey,
          requestFingerprint: operation.requestFingerprint,
          actorAuthority: operation.command.actorAuthority,
          createdAt: new Date(operation.createdAt),
        });
      const [identity] = await database
        .select({ publishedVersion: managedSitePages.publishedVersion })
        .from(managedSitePages)
        .where(
          and(
            eq(managedSitePages.ownerUserId, ownerUserId),
            eq(managedSitePages.projectId, projectId),
            eq(managedSitePages.pageId, page.pageId)
          )
        )
        .limit(1);
      await database
        .update(managedSiteMediaUsageBindings)
        .set({ releasedAt: new Date() })
        .where(
          and(
            eq(managedSiteMediaUsageBindings.ownerUserId, ownerUserId),
            eq(managedSiteMediaUsageBindings.projectId, projectId),
            eq(managedSiteMediaUsageBindings.pageId, page.pageId),
            ne(
              managedSiteMediaUsageBindings.pageVersion,
              identity?.publishedVersion || 0
            ),
            isNull(managedSiteMediaUsageBindings.releasedAt)
          )
        );
      if (page.mediaBindings.length)
        await database
          .insert(managedSiteMediaUsageBindings)
          .values(
            page.mediaBindings.map(binding => {
              const block = page.sections.find(section =>
                section.mediaBindingIds.includes(binding.bindingId)
              );
              const bindingFingerprint = canonicalFingerprint({
                version: "managed-site-media-usage-v1",
                ownerUserId,
                projectId,
                pageId: page.pageId,
                pageVersion: page.version,
                blockId: block?.blockId || "seo",
                role: binding.role,
                assetId: binding.assetId,
                assetVersion: binding.assetVersion,
                assetSha256: binding.assetSha256,
              });
              return {
                ownerUserId,
                projectId,
                assetId: binding.assetId,
                assetVersion: binding.assetVersion,
                assetSha256: binding.assetSha256,
                pageId: page.pageId,
                pageVersion: page.version,
                blockId: block?.blockId || "seo",
                role: binding.role,
                bindingFingerprint,
                releasedAt: null,
              };
            })
          )
          .onDuplicateKeyUpdate({ set: { releasedAt: null } });
      return true;
    },
    async findOperation(ownerUserId, projectId, idempotencyKey) {
      const [row] = await database
        .select()
        .from(managedSitePageOperations)
        .where(
          and(
            eq(managedSitePageOperations.ownerUserId, ownerUserId),
            eq(managedSitePageOperations.projectId, projectId),
            eq(managedSitePageOperations.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (!row) return null;
      return {
        command: row.command as AppliedPageOperation["command"],
        fromVersion: row.fromVersion,
        toVersion: row.toVersion,
        requestFingerprint: row.requestFingerprint,
        resultFingerprint:
          (
            await repository.findVersion(
              ownerUserId,
              projectId,
              row.pageId,
              row.toVersion
            )
          )?.fingerprint || "",
        createdAt: row.createdAt.toISOString(),
      };
    },
    async appendPublicationReceipt(ownerUserId, projectId, input) {
      const [existing] = await database
        .select()
        .from(managedSitePagePublicationReceipts)
        .where(
          eq(
            managedSitePagePublicationReceipts.receiptFingerprint,
            input.receiptFingerprint
          )
        )
        .limit(1);
      if (existing) return receipt(existing);
      const releaseId = Number(input.releaseReference?.split(":").at(-1));
      const targetId = Number(
        input.publicationTargetReference?.split(":").at(-1)
      );
      await database.transaction(async (transaction: any) => {
        await transaction
          .insert(managedSitePagePublicationReceipts)
          .values({
            ownerUserId,
            projectId,
            pageId: input.pageId,
            pageVersion: input.pageVersion,
            releaseId: Number.isSafeInteger(releaseId) ? releaseId : null,
            publicationTargetId: Number.isSafeInteger(targetId)
              ? targetId
              : null,
            status: input.status,
            artifactFingerprint: input.artifactFingerprint,
            mediaSetFingerprint: input.mediaSetFingerprint,
            receiptFingerprint: input.receiptFingerprint,
            providerReceiptReference: null,
            createdAt: new Date(input.createdAt),
          });
        const page = await repository.findVersion(
          ownerUserId,
          projectId,
          input.pageId,
          input.pageVersion
        );
        if (!page)
          throw createError({
            statusCode: 409,
            statusMessage:
              "Publication receipt has no exact PageDocument version.",
          });
        await transaction
          .update(managedSiteMediaUsageBindings)
          .set({ releasedAt: new Date() })
          .where(
            and(
              eq(managedSiteMediaUsageBindings.ownerUserId, ownerUserId),
              eq(managedSiteMediaUsageBindings.projectId, projectId),
              eq(managedSiteMediaUsageBindings.pageId, input.pageId),
              isNull(managedSiteMediaUsageBindings.releasedAt)
            )
          );
        if (page.mediaBindings.length)
          await transaction
            .insert(managedSiteMediaUsageBindings)
            .values(
              page.mediaBindings.map(binding => {
                const block = page.sections.find(section =>
                  section.mediaBindingIds.includes(binding.bindingId)
                );
                const bindingFingerprint = canonicalFingerprint({
                  version: "managed-site-media-usage-v1",
                  ownerUserId,
                  projectId,
                  pageId: page.pageId,
                  pageVersion: page.version,
                  blockId: block?.blockId || "seo",
                  role: binding.role,
                  assetId: binding.assetId,
                  assetVersion: binding.assetVersion,
                  assetSha256: binding.assetSha256,
                });
                return {
                  ownerUserId,
                  projectId,
                  assetId: binding.assetId,
                  assetVersion: binding.assetVersion,
                  assetSha256: binding.assetSha256,
                  pageId: page.pageId,
                  pageVersion: page.version,
                  blockId: block?.blockId || "seo",
                  role: binding.role,
                  bindingFingerprint,
                  releasedAt: null,
                };
              })
            )
            .onDuplicateKeyUpdate({ set: { releasedAt: null } });
      });
      const [created] = await database
        .select()
        .from(managedSitePagePublicationReceipts)
        .where(
          eq(
            managedSitePagePublicationReceipts.receiptFingerprint,
            input.receiptFingerprint
          )
        )
        .limit(1);
      return receipt(created!);
    },
    async enqueuePublication(input) {
      return database.transaction(async (transaction: any) => {
        const requestBase = {
          version: "managed-site-page-publication-work-v1",
          ownerUserId: input.ownerUserId,
          projectId: input.projectId,
          clientId: input.clientId,
          pageId: input.page.pageId,
          pageVersion: input.page.version,
          pageFingerprint: input.page.fingerprint,
          releaseId: input.releaseId,
          operationKind: input.operationKind,
          artifactFingerprint: input.artifact.artifactFingerprint,
          mediaSetFingerprint: input.artifact.mediaSetFingerprint,
          idempotencyKey: input.idempotencyKey,
        };
        const transportBytes = serializeManagedPageTransport(input.artifact);
        if (!transportBytes)
          throw createError({
            statusCode: 422,
            statusMessage: "Compiled page cannot enter the managed-page transport.",
          });
        const artifactBytes = Buffer.byteLength(transportBytes, "utf8");
        const contentHash = createHash("sha256")
          .update(transportBytes, "utf8")
          .digest("hex");
        const existing = await transaction
          .select()
          .from(managedSitePagePublicationWorks)
          .where(
            and(
              eq(
                managedSitePagePublicationWorks.ownerUserId,
                input.ownerUserId
              ),
              eq(managedSitePagePublicationWorks.projectId, input.projectId),
              eq(
                managedSitePagePublicationWorks.idempotencyKey,
                input.idempotencyKey
              )
            )
          );
        if (existing.length) {
          const existingTargets = existing
            .map((row: any) => row.publicationTargetId)
            .sort((left: number, right: number) => left - right);
          const requestedTargets = [...input.targetIds].sort(
            (left, right) => left - right
          );
          if (
            canonicalJson(existingTargets) !== canonicalJson(requestedTargets)
          )
            throw createError({
              statusCode: 409,
              statusMessage:
                "Publication idempotency key collided with a different target set.",
            });
          if (
            existing.length !== input.targetIds.length ||
            existing.some(
              (row: any) =>
                row.requestFingerprint !==
                canonicalFingerprint({
                  ...requestBase,
                  publicationTargetId: row.publicationTargetId,
                })
            )
          )
            throw createError({
              statusCode: 409,
              statusMessage:
                "Publication idempotency key collided with different canonical work.",
            });
          const receiptRows = await transaction
            .select()
            .from(managedSitePagePublicationReceipts)
            .where(
              and(
                eq(
                  managedSitePagePublicationReceipts.ownerUserId,
                  input.ownerUserId
                ),
                eq(
                  managedSitePagePublicationReceipts.projectId,
                  input.projectId
                ),
                eq(
                  managedSitePagePublicationReceipts.pageId,
                  input.page.pageId
                ),
                eq(
                  managedSitePagePublicationReceipts.pageVersion,
                  input.page.version
                )
              )
            );
          const replay = receiptRows
            .map(receipt)
            .find(
              (item: PagePublicationReceipt) =>
                item.releaseReference === `release:${input.releaseId}` &&
                item.publicationTargetReference ===
                  `target:${existing[0]!.publicationTargetId}`
            );
          if (!replay)
            throw createError({
              statusCode: 409,
              statusMessage: "Publication work replay has no durable receipt.",
            });
          return {
            receipt: replay,
            workIds: existing.map((row: any) => row.id),
            replayed: true,
          };
        }
        if (
          !input.targetIds.length ||
          new Set(input.targetIds).size !== input.targetIds.length
        )
          throw createError({
            statusCode: 422,
            statusMessage: "Publication targets are missing or duplicated.",
          });
        const values = input.targetIds.map(publicationTargetId => ({
          ownerUserId: input.ownerUserId,
          projectId: input.projectId,
          clientId: input.clientId,
          pageId: input.page.pageId,
          pageVersion: input.page.version,
          releaseId: input.releaseId,
          publicationTargetId,
          operationKind: input.operationKind,
          artifact: input.artifact,
          artifactBytes,
          artifactFingerprint: input.artifact.artifactFingerprint,
          mediaSetFingerprint: input.artifact.mediaSetFingerprint,
          pageFingerprint: input.page.fingerprint,
          contentHash,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: canonicalFingerprint({
            ...requestBase,
            publicationTargetId,
          }),
          status: "queued" as const,
          availableAt: input.createdAt,
        }));
        await transaction
          .insert(managedSitePagePublicationWorks)
          .values(values);
        const workRows = await transaction
          .select()
          .from(managedSitePagePublicationWorks)
          .where(
            and(
              eq(
                managedSitePagePublicationWorks.ownerUserId,
                input.ownerUserId
              ),
              eq(managedSitePagePublicationWorks.projectId, input.projectId),
              eq(
                managedSitePagePublicationWorks.idempotencyKey,
                input.idempotencyKey
              )
            )
          );
        const receipts: PagePublicationReceipt[] = [];
        for (const targetId of input.targetIds) {
          const base = {
            ...requestBase,
            receiptVersion: "managed-site-page-publication-intent-v2",
            publicationTargetId: targetId,
          };
          const fingerprint = canonicalFingerprint(base);
          await transaction
            .insert(managedSitePagePublicationReceipts)
            .values({
              ownerUserId: input.ownerUserId,
              projectId: input.projectId,
              pageId: input.page.pageId,
              pageVersion: input.page.version,
              releaseId: input.releaseId,
              publicationTargetId: targetId,
              status: "intent_created",
              artifactFingerprint: input.artifact.artifactFingerprint,
              mediaSetFingerprint: input.artifact.mediaSetFingerprint,
              receiptFingerprint: fingerprint,
              providerReceiptReference: null,
              createdAt: input.createdAt,
            });
          receipts.push({
            pageId: input.page.pageId,
            pageVersion: input.page.version,
            status: "intent_created",
            artifactFingerprint: input.artifact.artifactFingerprint,
            mediaSetFingerprint: input.artifact.mediaSetFingerprint,
            releaseReference: `release:${input.releaseId}`,
            publicationTargetReference: `target:${targetId}`,
            receiptFingerprint: fingerprint,
            createdAt: input.createdAt.toISOString(),
          });
        }
        if (input.page.mediaBindings.length)
          await transaction
            .insert(managedSiteMediaUsageBindings)
            .values(
              input.page.mediaBindings.map(binding => {
                const block = input.page.sections.find(section =>
                  section.mediaBindingIds.includes(binding.bindingId)
                );
                const bindingFingerprint = canonicalFingerprint({
                  version: "managed-site-media-usage-v1",
                  ownerUserId: input.ownerUserId,
                  projectId: input.projectId,
                  pageId: input.page.pageId,
                  pageVersion: input.page.version,
                  blockId: block?.blockId || "seo",
                  role: binding.role,
                  assetId: binding.assetId,
                  assetVersion: binding.assetVersion,
                  assetSha256: binding.assetSha256,
                });
                return {
                  ownerUserId: input.ownerUserId,
                  projectId: input.projectId,
                  assetId: binding.assetId,
                  assetVersion: binding.assetVersion,
                  assetSha256: binding.assetSha256,
                  pageId: input.page.pageId,
                  pageVersion: input.page.version,
                  blockId: block?.blockId || "seo",
                  role: binding.role,
                  bindingFingerprint,
                  releasedAt: null,
                };
              })
            )
            .onDuplicateKeyUpdate({ set: { releasedAt: null } });
        const pageUpdated = await transaction
          .update(managedSitePages)
          .set({ status: "publishing", updatedAt: input.createdAt })
          .where(
            and(
              eq(managedSitePages.ownerUserId, input.ownerUserId),
              eq(managedSitePages.projectId, input.projectId),
              eq(managedSitePages.pageId, input.page.pageId),
              eq(managedSitePages.currentDraftVersion, input.page.version)
            )
          );
        if (rowsAffected(pageUpdated) !== 1)
          throw createError({
            statusCode: 409,
            statusMessage:
              "Page changed while publication work was being created.",
          });
        return {
          receipt: receipts[0]!,
          workIds: workRows.map((row: any) => row.id),
          replayed: false,
        };
      });
    },
    async listPublicationReceipts(ownerUserId, projectId, pageId) {
      const rows = await database
        .select()
        .from(managedSitePagePublicationReceipts)
        .where(
          and(
            eq(managedSitePagePublicationReceipts.ownerUserId, ownerUserId),
            eq(managedSitePagePublicationReceipts.projectId, projectId),
            eq(managedSitePagePublicationReceipts.pageId, pageId)
          )
        )
        .orderBy(desc(managedSitePagePublicationReceipts.createdAt))
        .limit(200);
      return rows.map(receipt);
    },
  };
  return repository;
}
export function getDrizzlePageEditorRepository(): PageEditorRepository {
  return makeDrizzlePageEditorRepository(dbOrThrow());
}
