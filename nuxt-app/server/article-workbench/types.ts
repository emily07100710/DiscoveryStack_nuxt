/** Manual, owner-prepared article authoring. This is not an autonomous ML policy. */
export type ArticleRun = {text:string;bold?:boolean;italic?:boolean;color?:string}
export type ArticleTextBlock = {id:string;type:'paragraph'|'heading'|'quote';runs:ArticleRun[]}
export type ArticleImageBlock = {id:string;type:'image';mediaId:string;alt:string;caption:string;layout:'auto'|'wide'}
export type ArticleDocument = {schemaVersion:1;title:string;slug:string;summary:string;category:string;takeaways:string[];coverMediaId:string|null;blocks:(ArticleTextBlock|ArticleImageBlock)[]}
export type ArticleMediaManifest = {id:string;sha256:string;version:number;mimeType:'image/jpeg'|'image/png'|'image/webp';size:number;width:number;height:number;url:string}
export type ArticleStatus = 'preparing'|'editing'|'changes_requested'|'approved'|'processing'|'published'|'retry_wait'|'failed'|'revoked'
export type ArticleNotificationStatus = 'queued'|'processing'|'sent'|'retry_wait'|'failed'
export type ArticleTarget = {targetId:string;targetOrigin:string;ownerScopeKey:string;configurationFingerprint:string;credentialFingerprint:string}
export type ArticleAuthority = ArticleTarget & {purpose:'owner_prepared_article_v1';ownerUserId:number;clientId:number;bindingId:number;bindingFingerprint:string;authorizedAt:string;expiresAt:string;authorityFingerprint:string}
export type ArticleWorkspaceDto = {
  workspaceId:string;version:number;documentHash:string;document:ArticleDocument;status:ArticleStatus
  sourceLabel:'owner_prepared_manual';expiresAt:string;createdAt:string;approvedAt:string|null
  company:{displayName:string;canonicalSiteOrigin:string};media:ArticleMediaManifest[]
  feedback:{note:string;version:number;createdAt:string}[];publicationUrl:string|null
  notificationStatus:ArticleNotificationStatus;publicationErrorCode:string|null;canEdit:boolean;canApprove:boolean
  preparationStatus:'queued'|'processing'|'ready'|'retry_wait'|'failed'
}
export type ArticleIdentity = {lineUserId:string;channelId:string;expiresAtSeconds:number}
export type ArticleActor = {kind:'owner';ownerUserId:number}|{kind:'customer';identity:ArticleIdentity}
export type ArticleApproval = {approvedAt:string;reviewFingerprint:string;approvedDocumentVersion:number;approvedDocumentHash:string;approvedMediaManifestHash:string}
export type ArticlePrepareInput = {workspaceId:string;documentHash:string;document:ArticleDocument;media:ArticleMediaManifest[];authority:ArticleAuthority;retryKey:string}
export type ArticlePrepareResult = {postId:string;postVersion:1}
export type ArticlePublishInput = ArticlePrepareInput & {version:number;remotePostId:string;remotePostVersion:number;approval:ArticleApproval}
export type ArticlePublishResult = {published:true;url:string;providerPostId:string}|{published:false;retryable:boolean;errorCode:string}
export type ArticleNotifyInput = {lineUserId:string;workspaceId:string;title:string;retryKey:string;expiresAt:string}
export type ArticleNotifyResult = {accepted:true;providerMessageId?:string}|{accepted:false;retryable:boolean;errorCode:string}
export const ARTICLE_WORKSPACE_ID = /^aw_[A-Za-z0-9_-]{32}$/u
export const ARTICLE_MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
export const ARTICLE_SOURCE_LABEL = 'owner_prepared_manual' as const
export const ARTICLE_OWNER_CONFIRMATION = 'SEND_FORMAL_ARTICLE' as const
export const ARTICLE_CUSTOMER_CONFIRMATION = 'APPROVE_AND_PUBLISH' as const
