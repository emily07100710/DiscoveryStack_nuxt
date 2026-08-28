import { runDrizzleEditorMaintenance } from '../../managed-sites/page-editor/scheduler-drizzle'
export default defineTask({ meta: { name: 'managed-sites:editor-tick', description: 'Bounded leased media, visibility, retention, upload-expiry, and governed first-party publication execution.' }, async run() { return { result: await runDrizzleEditorMaintenance() } } })
