import { createError } from "h3";
import { canonicalFingerprint } from "./canonical";
import type {
  AppliedPageOperation,
  PageDocument,
  PageEditorRepository,
  PagePublicationReceipt,
} from "./types";

const scope = (ownerUserId: number, projectId: number) =>
  `${ownerUserId}:${projectId}`;
const pageKey = (ownerUserId: number, projectId: number, pageId: string) =>
  `${scope(ownerUserId, projectId)}:${pageId}`;
function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryPageEditorRepository(): PageEditorRepository {
  const pages = new Map<string, PageDocument[]>();
  const operations = new Map<string, AppliedPageOperation>();
  const receipts = new Map<string, PagePublicationReceipt[]>();
  const publicationClaims = new Map<
    string,
    { fingerprint: string; receipt: PagePublicationReceipt; workIds: number[] }
  >();
  let workSequence = 0;
  let transactionTail = Promise.resolve();
  const repository: PageEditorRepository = {
    async transaction<T>(
      work: (repository: PageEditorRepository) => Promise<T>
    ): Promise<T> {
      let release!: () => void;
      const preceding = transactionTail;
      transactionTail = new Promise<void>(resolve => {
        release = resolve;
      });
      await preceding;
      try {
        return await work(repository);
      } finally {
        release();
      }
    },
    async listPages(ownerUserId, projectId, options = {}) {
      const limit = Number.isSafeInteger(options.limit)
        ? Math.max(1, Math.min(100, options.limit!))
        : 100;
      return [...pages.entries()]
        .filter(([key]) => key.startsWith(`${scope(ownerUserId, projectId)}:`))
        .map(([, versions]) => clone(versions.at(-1)!))
        .filter(page =>
          !options.afterRoute ||
          !options.afterPageId ||
          page.route > options.afterRoute ||
          (page.route === options.afterRoute && page.pageId > options.afterPageId)
        )
        .sort((a, b) =>
          a.route === b.route
            ? a.pageId < b.pageId
              ? -1
              : a.pageId > b.pageId
                ? 1
                : 0
            : a.route < b.route
              ? -1
              : 1
        )
        .slice(0, limit);
    },
    async findCurrent(ownerUserId, projectId, pageId) {
      const versions = pages.get(pageKey(ownerUserId, projectId, pageId));
      return versions?.length ? clone(versions.at(-1)!) : null;
    },
    async findVersion(ownerUserId, projectId, pageId, version) {
      const value = pages
        .get(pageKey(ownerUserId, projectId, pageId))
        ?.find(item => item.version === version);
      return value ? clone(value) : null;
    },
    async listVersions(ownerUserId, projectId, pageId) {
      return (pages.get(pageKey(ownerUserId, projectId, pageId)) || [])
        .map(clone)
        .sort((a, b) => b.version - a.version);
    },
    async insertInitial(ownerUserId, projectId, page) {
      const key = pageKey(ownerUserId, projectId, page.pageId);
      if (pages.has(key) || page.version !== 1)
        throw createError({
          statusCode: 409,
          statusMessage: "Initial page identity or version collided.",
        });
      pages.set(key, [clone(page)]);
    },
    async compareAndAppend(
      ownerUserId,
      projectId,
      expectedVersion,
      page,
      operation
    ) {
      const key = pageKey(ownerUserId, projectId, page.pageId);
      const versions = pages.get(key);
      if (
        !versions?.length ||
        versions.at(-1)!.version !== expectedVersion ||
        page.version !== expectedVersion + 1
      )
        return false;
      versions.push(clone(page));
      operations.set(
        `${scope(ownerUserId, projectId)}:${operation.command.idempotencyKey}`,
        clone(operation)
      );
      return true;
    },
    async findOperation(ownerUserId, projectId, idempotencyKey) {
      const value = operations.get(
        `${scope(ownerUserId, projectId)}:${idempotencyKey}`
      );
      return value ? clone(value) : null;
    },
    async appendPublicationReceipt(ownerUserId, projectId, receipt) {
      const key = pageKey(ownerUserId, projectId, receipt.pageId);
      const list = receipts.get(key) || [];
      const existing = list.find(
        item => item.receiptFingerprint === receipt.receiptFingerprint
      );
      if (existing) return clone(existing);
      list.push(clone(receipt));
      receipts.set(key, list);
      return clone(receipt);
    },
    async enqueuePublication(input) {
      const key = `${scope(input.ownerUserId, input.projectId)}:${input.idempotencyKey}`;
      const fingerprint = canonicalFingerprint({
        ...input,
        createdAt: input.createdAt.toISOString(),
      });
      const existing = publicationClaims.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw createError({
            statusCode: 409,
            statusMessage:
              "Publication idempotency key collided with different canonical work.",
          });
        return {
          receipt: clone(existing.receipt),
          workIds: [...existing.workIds],
          replayed: true,
        };
      }
      const targetId = input.targetIds[0];
      if (!targetId)
        throw createError({
          statusCode: 422,
          statusMessage: "Publication target is required.",
        });
      const receipt: PagePublicationReceipt = {
        pageId: input.page.pageId,
        pageVersion: input.page.version,
        status: "intent_created",
        artifactFingerprint: input.artifact.artifactFingerprint,
        mediaSetFingerprint: input.artifact.mediaSetFingerprint,
        releaseReference: `release:${input.releaseId}`,
        publicationTargetReference: `target:${targetId}`,
        receiptFingerprint: canonicalFingerprint({
          version: "managed-site-page-publication-intent-v2",
          fingerprint,
          targetId,
        }),
        createdAt: input.createdAt.toISOString(),
      };
      await repository.appendPublicationReceipt(
        input.ownerUserId,
        input.projectId,
        receipt
      );
      const workIds = input.targetIds.map(() => ++workSequence);
      publicationClaims.set(key, {
        fingerprint,
        receipt: clone(receipt),
        workIds,
      });
      return { receipt, workIds, replayed: false };
    },
    async listPublicationReceipts(ownerUserId, projectId, pageId) {
      return (receipts.get(pageKey(ownerUserId, projectId, pageId)) || []).map(
        clone
      );
    },
  };
  return repository;
}
