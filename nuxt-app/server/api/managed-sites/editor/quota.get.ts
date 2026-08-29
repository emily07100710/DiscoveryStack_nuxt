import { requireEditorActor } from '../../../managed-sites/page-editor/http'
import { getDrizzleMediaVaultRepository } from '../../../managed-sites/media-vault/repository-drizzle'
export default defineEventHandler(async event => { const { mediaActor } = await requireEditorActor(event); return { quota: await getDrizzleMediaVaultRepository().getQuota(mediaActor) } })
