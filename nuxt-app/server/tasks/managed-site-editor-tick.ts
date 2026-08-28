import { runDrizzleEditorMaintenance } from '../managed-sites/page-editor/scheduler-drizzle'
export default defineTask({ meta: { name: 'managed-sites:editor-tick', description: 'Bounded media/page editor maintenance without provider or deployment calls.' }, async run() { return { result: await runDrizzleEditorMaintenance() } } })
