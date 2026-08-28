import type { MediaAssetProjection } from '../media-vault/types'

export const PAGE_DOCUMENT_VERSION = 'managed-site-page-document-v1' as const
export const PAGE_COMMAND_VERSION = 'managed-site-page-command-v1' as const
export const BLOCK_TYPES = ['hero', 'rich_text', 'image_text', 'services', 'case_studies', 'gallery_grid', 'carousel', 'team', 'testimonials', 'faq', 'cta', 'article_list', 'contact', 'booking_intent', 'spacer', 'divider'] as const
export type BlockType = typeof BLOCK_TYPES[number]
export type EditorRole = 'platform_owner' | 'customer_admin' | 'editor' | 'viewer'
export interface PageActor { ownerUserId: number; projectId: number; actorUserId: number | null; authority: 'owner_session' | 'customer_session' | 'system_workflow' | 'system_test'; role: EditorRole; canPublish: boolean }
export interface SafeLink { label: string; href: string; newTab?: boolean }
export type RichTextNode = { type: 'paragraph'; text: string } | { type: 'heading'; level: 2 | 3; text: string } | { type: 'list'; ordered: boolean; items: string[] }
export interface PageMediaBinding { bindingId: string; assetId: string; assetVersion: number; assetSha256: string; role: 'hero' | 'content' | 'gallery' | 'avatar' | 'thumbnail' | 'background'; alt: string; decorative: boolean; caption?: string; focalPoint?: { x: number; y: number }; provenance: 'customer' | 'platform_owner' | 'ai_suggestion_pending' | 'ai_suggestion_customer_approved' }
export interface ScheduledVisibility { visibleFrom: string | null; visibleUntil: string | null; timezone: string }
export interface PageBlock { blockId: string; type: BlockType; visible: boolean; layoutVariant: string; data: Readonly<Record<string, unknown>>; mediaBindingIds: string[]; schedule: ScheduledVisibility | null }
export interface PageDesignTokens { palette: 'indigo_sand' | 'charcoal_ivory' | 'forest_mist'; typeScale: 'compact' | 'balanced' | 'editorial'; spacing: 'compact' | 'balanced' | 'airy'; radius: 'none' | 'soft' | 'rounded'; maxWidth: 'narrow' | 'standard' | 'wide'; contrast: 'aa' | 'aaa' }
export interface PageSeo { title: string; description: string; canonicalPath: string; noindex: boolean; ogBindingId: string | null }
export interface PageDocument {
  schemaVersion: typeof PAGE_DOCUMENT_VERSION; pageId: string; version: number; locale: 'zh-hant' | 'en'; route: string; contentType: 'home' | 'standard' | 'services' | 'cases' | 'contact' | 'articles'; designThemeId: string; designTokenVersion: string; designTokens: PageDesignTokens; sections: PageBlock[]; seo: PageSeo; publicationState: 'draft' | 'preview' | 'published' | 'superseded' | 'rolled_back'; mediaBindings: PageMediaBinding[]; fingerprint: string; parentVersion: number | null; actorAuthority: string; createdAt: string
}
export interface ResponsiveMediaProjection { bindingId: string; assetId: string; assetVersion: number; assetSha256: string; alt: string; decorative: boolean; loading: 'eager' | 'lazy'; fetchPriority: 'high' | 'auto'; width: number; height: number; srcset: string; sizes: string; focalPoint: { x: number; y: number } | null }
export interface CompiledPageArtifact { version: 'managed-site-page-artifact-v1'; pageId: string; pageVersion: number; route: string; locale: string; contentType: string; design: PageDesignTokens; blocks: Array<PageBlock & { responsive: { desktop: string; tablet: string; mobile: string }; media: ResponsiveMediaProjection[] }>; seo: PageSeo; pageFingerprint: string; mediaSetFingerprint: string; artifactFingerprint: string; generatedAt: string }

export type PageCommandType = 'update_text' | 'update_link' | 'replace_media' | 'add_block' | 'remove_block' | 'duplicate_block' | 'move_block' | 'update_block_variant' | 'update_items' | 'toggle_visibility' | 'schedule_visibility' | 'update_seo' | 'restore_version'
export interface PageCommand { schemaVersion: typeof PAGE_COMMAND_VERSION; type: PageCommandType; expectedPageVersion: number; idempotencyKey: string; target: { blockId?: string; path?: string; index?: number; bindingId?: string; version?: number }; payload: unknown; reason: string }
export interface AppliedPageOperation { command: PageCommand & { actorAuthority: string }; fromVersion: number; toVersion: number; requestFingerprint: string; resultFingerprint: string; createdAt: string }
export interface PageDiff { fromVersion: number; toVersion: number; changedBlockIds: string[]; addedBlockIds: string[]; removedBlockIds: string[]; mediaChanges: Array<{ bindingId: string; beforeAssetId: string | null; afterAssetId: string | null }>; seoChanged: boolean; beforeFingerprint: string; afterFingerprint: string; diffFingerprint: string }

export interface PageEditorRepository {
  transaction<T>(work: (repository: PageEditorRepository) => Promise<T>): Promise<T>
  listPages(ownerUserId: number, projectId: number): Promise<PageDocument[]>
  findCurrent(ownerUserId: number, projectId: number, pageId: string): Promise<PageDocument | null>
  findVersion(ownerUserId: number, projectId: number, pageId: string, version: number): Promise<PageDocument | null>
  listVersions(ownerUserId: number, projectId: number, pageId: string): Promise<PageDocument[]>
  insertInitial(ownerUserId: number, projectId: number, page: PageDocument): Promise<void>
  compareAndAppend(ownerUserId: number, projectId: number, expectedVersion: number, page: PageDocument, operation: AppliedPageOperation): Promise<boolean>
  findOperation(ownerUserId: number, projectId: number, idempotencyKey: string): Promise<AppliedPageOperation | null>
  appendPublicationReceipt(ownerUserId: number, projectId: number, receipt: PagePublicationReceipt): Promise<PagePublicationReceipt>
  listPublicationReceipts(ownerUserId: number, projectId: number, pageId: string): Promise<PagePublicationReceipt[]>
}
export interface PagePublicationReceipt { pageId: string; pageVersion: number; status: 'intent_created' | 'succeeded' | 'failed' | 'rolled_back'; artifactFingerprint: string; mediaSetFingerprint: string; releaseReference: string | null; publicationTargetReference: string | null; receiptFingerprint: string; createdAt: string }
export type MediaAuthorityResolver = (actor: PageActor, binding: PageMediaBinding) => Promise<MediaAssetProjection | null>

export interface AiPlanningContext { page: PageDocument; approvedMedia: Array<Pick<MediaAssetProjection, 'assetId' | 'version' | 'sha256' | 'width' | 'height' | 'filename' | 'visibility' | 'status'>>; commandCatalog: readonly PageCommandType[]; untrustedContentBoundary: true; maxOperations: number }
export interface AiPlannerPort { readonly providerKey: string; plan(input: { intent: WebsiteEditIntent; request: string; context: AiPlanningContext; maxOutputTokens: number; timeoutMs: number }): Promise<unknown> }
export type WebsiteEditIntent = 'organize_case_studies' | 'refine_layout' | 'replace_hero' | 'normalize_service_images' | 'mobile_carousel_fallback' | 'schedule_campaign' | 'move_block' | 'undo' | 'bounded_clarification' | 'unrelated_refusal'
export interface AiEditProposal { proposalId: string; ownerUserId: number; projectId: number; pageId: string; intent: WebsiteEditIntent; summary: string; operations: PageCommand[]; diff: PageDiff | null; warnings: string[]; affectedBlockIds: string[]; expectedPageVersion: number; proposalFingerprint: string; status: 'proposed' | 'clarification_required' | 'refused'; expiresAt: string; mayPublishDirectly: false; visionMode: 'metadata_only' | 'injected_provider' }
